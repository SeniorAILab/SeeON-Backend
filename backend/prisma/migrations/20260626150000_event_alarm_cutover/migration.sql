-- PR5 Event -> Alert cutover controls and Event-origin alert uniqueness.
CREATE TYPE "CameraIngestMode" AS ENUM ('LEGACY_ALERTS', 'EVENT_API');

ALTER TABLE cameras
  ADD COLUMN ingest_mode "CameraIngestMode" NOT NULL DEFAULT 'LEGACY_ALERTS';

ALTER TABLE alerts
  ADD COLUMN origin_event_id TEXT;

ALTER TABLE alerts ADD CONSTRAINT alerts_facility_id_origin_event_id_fkey
  FOREIGN KEY (facility_id, origin_event_id) REFERENCES events(facility_id, id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX alerts_facility_origin_event_unique
  ON alerts(facility_id, origin_event_id)
  WHERE origin_event_id IS NOT NULL;

DROP FUNCTION IF EXISTS get_camera_for_ingest(TEXT);
CREATE OR REPLACE FUNCTION get_camera_for_ingest(p_key_id TEXT)
RETURNS TABLE(
  id TEXT,
  "facilityId" TEXT,
  "spaceId" TEXT,
  "ingestKeyId" TEXT,
  "ingestSecretHash" TEXT,
  "ingestMode" "CameraIngestMode"
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id,
         facility_id AS "facilityId",
         space_id AS "spaceId",
         ingest_key_id AS "ingestKeyId",
         ingest_secret_hash AS "ingestSecretHash",
         ingest_mode AS "ingestMode"
  FROM public.cameras
  WHERE ingest_key_id = p_key_id
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION get_camera_for_ingest(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_camera_for_ingest(TEXT) TO fall_app;

DROP FUNCTION IF EXISTS get_camera_for_event_ingest(TEXT);
CREATE OR REPLACE FUNCTION get_camera_for_event_ingest(p_camera_id TEXT)
RETURNS TABLE(
  id TEXT,
  facility_id TEXT,
  space_id TEXT,
  ingest_mode "CameraIngestMode"
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, facility_id, space_id, ingest_mode
  FROM public.cameras
  WHERE id = p_camera_id
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION get_camera_for_event_ingest(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_camera_for_event_ingest(TEXT) TO fall_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON cameras TO fall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON alerts TO fall_app;
