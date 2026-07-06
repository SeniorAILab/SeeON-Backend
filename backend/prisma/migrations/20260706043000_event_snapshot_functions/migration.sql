-- Restore the SECURITY DEFINER snapshot path for immutable events.
-- event-recorder.service.ts calls get_event_for_snapshot() and
-- set_event_snapshot_key(), but the migration defining them was excluded from
-- the phase-1 subset commit (4ce8a8b) on the assumption `prisma migrate` would
-- regenerate it; raw SQL functions are not representable in schema.prisma, so
-- every database built from migrations rejects snapshot uploads with 42883.
-- events keeps REVOKE UPDATE (20260626120000_event_ssot); these functions are
-- the only sanctioned write path for events.snapshot_key.

ALTER TABLE events ADD COLUMN IF NOT EXISTS snapshot_key TEXT;

DROP FUNCTION IF EXISTS get_event_for_snapshot(TEXT);
CREATE OR REPLACE FUNCTION get_event_for_snapshot(p_event_id TEXT)
RETURNS TABLE(id TEXT, facility_id TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT e.id, e.facility_id
  FROM public.events e
  WHERE e.id = p_event_id
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION get_event_for_snapshot(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_event_for_snapshot(TEXT) TO fall_app;

DROP FUNCTION IF EXISTS set_event_snapshot_key(TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION set_event_snapshot_key(
  p_event_id TEXT,
  p_facility_id TEXT,
  p_snapshot_key TEXT
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.events
  SET snapshot_key = p_snapshot_key,
      modified_at = CURRENT_TIMESTAMP
  WHERE id = p_event_id
    AND facility_id = p_facility_id;
$$;

REVOKE EXECUTE ON FUNCTION set_event_snapshot_key(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_event_snapshot_key(TEXT, TEXT, TEXT) TO fall_app;
