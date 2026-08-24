-- ============================================================
-- 040_broadcast_scheduler
-- Adds scheduled broadcast support via QStash
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS qstash_message_id TEXT;

-- We update the status check constraint to allow 'canceled'
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'canceled'));

-- Drop the previous function so we can replace it with the new signature
DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]
);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id        UUID,
  p_user_id           UUID,
  p_name              TEXT,
  p_template_name     TEXT,
  p_template_language TEXT,
  p_total_recipients  INTEGER,
  p_contact_ids       UUID[],
  p_template_params   JSONB[],
  p_scheduled_at      TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
  v_initial_status TEXT;
BEGIN
  -- Determine initial status based on scheduled_at
  IF p_scheduled_at IS NOT NULL AND p_scheduled_at > NOW() THEN
    v_initial_status := 'scheduled';
  ELSE
    v_initial_status := 'sending';
  END IF;

  INSERT INTO broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients, scheduled_at
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, v_initial_status, p_total_recipients, p_scheduled_at
  )
  RETURNING id INTO v_broadcast_id;

  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, t.cid, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    RETURNING id, contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TIMESTAMPTZ) TO service_role;
