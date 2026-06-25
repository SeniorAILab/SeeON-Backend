-- Camera.spaceId expand: nullable room anchor with strict Space.cameraId backfill.

DO $$
DECLARE
  duplicate_same_facility INTEGER;
  missing_claim INTEGER;
  stale_claim INTEGER;
  cross_facility_claim INTEGER;
BEGIN
  SELECT COUNT(*) INTO duplicate_same_facility
  FROM (
    SELECT c.facility_id, c.id
    FROM cameras c
    JOIN spaces s ON s.facility_id = c.facility_id AND s.camera_id = c.id
    GROUP BY c.facility_id, c.id
    HAVING COUNT(*) <> 1
  ) bad;

  SELECT COUNT(*) INTO missing_claim
  FROM cameras c
  WHERE NOT EXISTS (
    SELECT 1 FROM spaces s
    WHERE s.facility_id = c.facility_id AND s.camera_id = c.id
  );

  SELECT COUNT(*) INTO stale_claim
  FROM spaces s
  WHERE s.camera_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM cameras c WHERE c.id = s.camera_id);

  SELECT COUNT(*) INTO cross_facility_claim
  FROM spaces s
  JOIN cameras c ON c.id = s.camera_id
  WHERE s.camera_id IS NOT NULL AND s.facility_id <> c.facility_id;

  IF duplicate_same_facility > 0 OR missing_claim > 0 OR stale_claim > 0 OR cross_facility_claim > 0 THEN
    RAISE EXCEPTION 'camera_space_expand blocked: duplicate_same_facility=%, missing_claim=%, stale_claim=%, cross_facility_claim=%. Remediate spaces.camera_id so every camera has exactly one same-facility Space claim. Camera.resident_id/ResidentAssignment may be reviewed only as manual mapping candidates; this migration never auto-fills from resident placement.',
      duplicate_same_facility, missing_claim, stale_claim, cross_facility_claim;
  END IF;
END $$;
ALTER TABLE cameras ADD COLUMN space_id TEXT;

UPDATE cameras c
SET space_id = s.id
FROM spaces s
WHERE s.facility_id = c.facility_id
  AND s.camera_id = c.id;

CREATE UNIQUE INDEX cameras_facility_id_space_id_key ON cameras(facility_id, space_id);

ALTER TABLE cameras ADD CONSTRAINT cameras_facility_id_space_id_fkey
  FOREIGN KEY (facility_id, space_id) REFERENCES spaces(facility_id, id) ON DELETE RESTRICT ON UPDATE CASCADE;

DROP FUNCTION IF EXISTS get_camera_for_ingest(TEXT);
CREATE OR REPLACE FUNCTION get_camera_for_ingest(p_key_id TEXT)
RETURNS TABLE(
  id TEXT,
  "facilityId" TEXT,
  "residentId" TEXT,
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
         resident_id AS "residentId",
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
