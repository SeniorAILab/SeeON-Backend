-- Ingest camera lookup: SECURITY DEFINER function so fall_app (NOBYPASSRLS)
-- can look up a camera by ingestKeyId without needing an org GUC.
-- The ingest path must find the camera to verify HMAC BEFORE knowing the orgId.
-- Limited to the minimal columns needed for HMAC verification + tenant check.
CREATE OR REPLACE FUNCTION get_camera_for_ingest(p_key_id TEXT)
RETURNS TABLE(
  id TEXT,
  "orgId" TEXT,
  "residentId" TEXT,
  "ingestKeyId" TEXT,
  "ingestSecretHash" TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, "orgId", "residentId", "ingestKeyId", "ingestSecretHash"
  FROM "Camera"
  WHERE "ingestKeyId" = p_key_id
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_camera_for_ingest(TEXT) TO fall_app;
