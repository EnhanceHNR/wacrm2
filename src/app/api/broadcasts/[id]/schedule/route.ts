import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { Client } from '@upstash/qstash';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createClient();
    
    // Verify user is authenticated
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: broadcast, error } = await supabase
      .from('broadcasts')
      .select('id, scheduled_at, user_id')
      .eq('id', params.id)
      .single();

    if (error || !broadcast) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
    }

    // Security check
    if (broadcast.user_id !== session.user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (!broadcast.scheduled_at) {
      return NextResponse.json({ error: 'Broadcast is not scheduled for the future' }, { status: 400 });
    }

    // Push to QStash
    const qstash = new Client({ token: process.env.QSTASH_TOKEN! });
    
    // Construct the absolute URL for the webhook execute endpoint
    // IMPORTANT: When deploying to Firebase/Vercel, we need the public URL.
    // If not available on req.url properly, it can be tricky. We use req.url as a base.
    const url = new URL(req.url);
    // VERCEL_URL or NEXT_PUBLIC_SITE_URL might be needed in production.
    const host = process.env.NEXT_PUBLIC_SITE_URL || `${url.protocol}//${url.host}`;
    const executeUrl = `${host}/api/broadcasts/${broadcast.id}/execute`;

    const scheduledDate = new Date(broadcast.scheduled_at);
    const notBefore = Math.floor(scheduledDate.getTime() / 1000);

    const message = await qstash.publishJSON({
      url: executeUrl,
      body: { broadcastId: broadcast.id },
      notBefore,
    });

    // Update the broadcast with the qstash_message_id
    await supabase
      .from('broadcasts')
      .update({ qstash_message_id: message.messageId })
      .eq('id', broadcast.id);

    return NextResponse.json({ success: true, messageId: message.messageId });
  } catch (err) {
    console.error('Failed to schedule in QStash:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
