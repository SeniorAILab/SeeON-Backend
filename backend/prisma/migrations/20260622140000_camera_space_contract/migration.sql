-- Camera.spaceId contract: require room anchor and finalize runtime lookup shape.

DO $$
DECLARE
  null_camera_space_count INTEGER;
BEGIN
  SELECT count(*) INTO null_camera_space_count
  FROM cameras
  WHERE space_id IS NULL;

  IF null_camera_space_count <> 0 THEN
    RAISE EXCEPTION 'camera_space_contract blocked: cameras.space_id contains % NULL row(s). Remediate camera room assignments before enforcing NOT NULL.', null_camera_space_count;
  END IF;
END $$;

ALTER TABLE cameras ALTER COLUMN space_id SET NOT NULL;

DROP INDEX IF EXISTS cameras_facility_id_space_id_partial_key;
DROP INDEX IF EXISTS cameras_facility_id_space_id_idx;
CREATE UNIQUE INDEX IF NOT EXISTS cameras_facility_id_space_id_key ON cameras(facility_id, space_id);

DROP FUNCTION IF EXISTS get_camera_for_ingest(TEXT);
CREATE OR REPLACE FUNCTION get_camera_for_ingest(p_key_id TEXT)
RETURNS TABLE(
  id TEXT,
  "facilityId" TEXT,
  "spaceId" TEXT,
  "ingestKeyId" TEXT,
  "ingestSecretHash" TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id,
         facility_id AS "facilityId",
         space_id AS "spaceId",
         ingest_key_id AS "ingestKeyId",
         ingest_secret_hash AS "ingestSecretHash"
  FROM cameras
  WHERE ingest_key_id = p_key_id
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_camera_for_ingest(TEXT) TO fall_app;

ALTER TABLE cameras ENABLE ROW LEVEL SECURITY;
ALTER TABLE cameras FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON cameras TO fall_app;
