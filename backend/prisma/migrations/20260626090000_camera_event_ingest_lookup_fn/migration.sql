-- Event ingest camera lookup: SECURITY DEFINER function so fall_app
-- can resolve camera_id before any facility RLS context exists.
-- Limited to the minimal topology columns required to bind facility context.
CREATE OR REPLACE FUNCTION get_camera_for_event_ingest(p_camera_id TEXT)
RETURNS TABLE(
  id TEXT,
  facility_id TEXT,
  space_id TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, facility_id, space_id
  FROM public.cameras
  WHERE id = p_camera_id
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION get_camera_for_event_ingest(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_camera_for_event_ingest(TEXT) TO fall_app;
