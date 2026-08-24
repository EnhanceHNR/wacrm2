import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifySignature } from '@upstash/qstash/nextjs';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { sanitizePhoneForMeta, isValidE164, phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handler(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const broadcastId = params.id;

  try {
    // 1. Lock the broadcast for delivery
    const { data: broadcast, error: lockErr } = await supabase
      .from('broadcasts')
      .update({
        status: 'sending',
        delivery_locked_at: new Date().toISOString()
      })
      .eq('id', broadcastId)
      .is('delivery_locked_at', null)
      .select()
      .single();

    if (lockErr || !broadcast) {
      console.log(`Broadcast ${broadcastId} is already locked or missing.`);
      return NextResponse.json({ success: true, message: 'Already processing or not found' });
    }

    // 2. Fetch pending recipients
    const { data: recipients, error: fetchErr } = await supabase
      .from('broadcast_recipients')
      .select('*, contact:contacts(*)')
      .eq('broadcast_id', broadcast.id)
      .eq('status', 'pending');

    if (fetchErr || !recipients || recipients.length === 0) {
      await supabase.from('broadcasts').update({ status: 'sent', delivery_locked_at: null }).eq('id', broadcast.id);
      return NextResponse.json({ success: true, message: 'No pending recipients' });
    }

    // 3. Load config and template
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', broadcast.account_id)
      .single();

    if (configError || !config) {
      await supabase.from('broadcasts').update({ status: 'failed', delivery_locked_at: null }).eq('id', broadcast.id);
      return NextResponse.json({ error: 'WhatsApp not configured' }, { status: 400 });
    }

    const accessToken = decrypt(config.access_token);

    const resolvedTemplate = await resolveTemplateRow(
      supabase,
      broadcast.account_id,
      broadcast.template_name,
      broadcast.template_language
    );

    if (resolvedTemplate.malformed) {
      await supabase.from('broadcasts').update({ status: 'failed', delivery_locked_at: null }).eq('id', broadcast.id);
      return NextResponse.json({ error: 'Template row malformed' }, { status: 500 });
    }

    const templateRow = resolvedTemplate.row;
    let failedCount = 0;

    // 4. Send messages
    for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
      const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

      for (const recipient of batch) {
        const phone = recipient.contact?.phone;
        
        if (!phone) {
          failedCount++;
          await supabase.from('broadcast_recipients').update({ status: 'failed', error_message: 'No phone' }).eq('id', recipient.id);
          continue;
        }

        const sanitized = sanitizePhoneForMeta(phone);
        if (!isValidE164(sanitized)) {
          failedCount++;
          await supabase.from('broadcast_recipients').update({ status: 'failed', error_message: 'Invalid phone' }).eq('id', recipient.id);
          continue;
        }

        const variants = phoneVariants(sanitized);
        let sentMessageId: string | null = null;
        let lastError: string | null = null;
        const params = Array.isArray(recipient.template_params) ? recipient.template_params : [];

        for (const variant of variants) {
          try {
            const result = await sendTemplateMessage({
              phoneNumberId: config.phone_number_id,
              accessToken,
              to: variant,
              templateName: broadcast.template_name,
              language: resolvedTemplate.language,
              template: templateRow ?? undefined,
              params: params,
            });
            sentMessageId = result.messageId;
            lastError = null;
            break;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            if (!isRecipientNotAllowedError(errorMessage)) {
              lastError = errorMessage;
              break;
            }
            lastError = errorMessage;
          }
        }

        if (sentMessageId) {
          await supabase.from('broadcast_recipients').update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            whatsapp_message_id: sentMessageId,
            error_message: null
          }).eq('id', recipient.id);
        } else {
          failedCount++;
          await supabase.from('broadcast_recipients').update({
            status: 'failed',
            error_message: lastError || 'Unknown error',
          }).eq('id', recipient.id);
        }
      }

      if (i + SEND_BATCH_SIZE < recipients.length) {
        await sleep(SEND_BATCH_DELAY_MS);
      }
    }

    // 5. Finalize status
    const finalStatus = failedCount === recipients.length ? 'failed' : 'sent';
    await supabase.from('broadcasts').update({ status: finalStatus, delivery_locked_at: null }).eq('id', broadcast.id);

    return NextResponse.json({ success: true, processed: recipients.length });

  } catch (err) {
    console.error('QStash execute error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// Wrap with QStash signature verification
export const POST = verifySignature(handler);
