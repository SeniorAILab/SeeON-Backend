-- Single-surface Event ingress cutover: remove the legacy HMAC /ingest surface
-- from the database. Drops the legacy camera resolver, the per-camera ingest_mode
-- dual-mode control, the HMAC credential columns, and the CameraIngestMode enum.
-- Order matters: every dependent (functions, columns) is removed before the type.

-- 1. Drop the legacy HMAC camera resolver (returns ingestKeyId/ingestSecretHash/ingestMode).
--    No longer used: the /ingest/* surface and HmacIngestGuard were removed in the cutover.
DROP FUNCTION IF EXISTS get_camera_for_ingest(TEXT);

-- 2. Recreate the Event ingest resolver returning only the minimal topology columns
--    (drop ingest_mode from its result so it no longer depends on CameraIngestMode).
DROP FUNCTION IF EXISTS get_camera_for_event_ingest(TEXT);
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

-- 3. Drop the HMAC credential unique index and columns.
DROP INDEX IF EXISTS cameras_facility_id_ingest_key_id_key;
ALTER TABLE cameras DROP COLUMN IF EXISTS ingest_key_id;
ALTER TABLE cameras DROP COLUMN IF EXISTS ingest_secret_hash;

-- 4. Drop the per-camera ingest_mode column, then the now-unreferenced enum type.
ALTER TABLE cameras DROP COLUMN IF EXISTS ingest_mode;
DROP TYPE IF EXISTS "CameraIngestMode";
