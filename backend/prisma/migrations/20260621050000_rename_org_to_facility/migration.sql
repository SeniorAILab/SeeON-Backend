-- Behavior-preserving tenant terminology rename: org -> facility.
-- Uses ALTER ... RENAME only for existing tables/columns so data, FKs, and rows are preserved.

-- RLS policies reference org_id/app.org_id and must be recreated after column/GUC rename.
DROP POLICY tenant_isolation ON residents;
DROP POLICY tenant_isolation ON guardians;
DROP POLICY tenant_isolation ON cameras;
DROP POLICY tenant_isolation ON alerts;
DROP POLICY tenant_isolation ON resident_statuses;

-- Root tenant table.
ALTER TABLE organizations RENAME TO facilities;
ALTER TABLE facilities RENAME CONSTRAINT organizations_pkey TO facilities_pkey;

-- Tenant key columns.
ALTER TABLE residents RENAME COLUMN org_id TO facility_id;
ALTER TABLE guardians RENAME COLUMN org_id TO facility_id;
ALTER TABLE cameras RENAME COLUMN org_id TO facility_id;
ALTER TABLE alerts RENAME COLUMN org_id TO facility_id;
ALTER TABLE resident_statuses RENAME COLUMN org_id TO facility_id;
ALTER TABLE users RENAME COLUMN org_id TO facility_id;
ALTER TABLE kakao_identities RENAME COLUMN org_id TO facility_id;
ALTER TABLE server_sessions RENAME COLUMN org_id TO facility_id;

-- Constraint and index names are cosmetic, but keeping them aligned avoids future drift.
ALTER INDEX residents_org_id_id_key RENAME TO residents_facility_id_id_key;
ALTER INDEX cameras_org_id_id_key RENAME TO cameras_facility_id_id_key;
ALTER INDEX cameras_org_id_label_key RENAME TO cameras_facility_id_label_key;
ALTER INDEX cameras_org_id_ingest_key_id_key RENAME TO cameras_facility_id_ingest_key_id_key;
ALTER INDEX alerts_org_id_alert_seq_idx RENAME TO alerts_facility_id_alert_seq_idx;
ALTER INDEX alerts_org_id_idempotency_key_key RENAME TO alerts_facility_id_idempotency_key_key;
ALTER INDEX resident_statuses_org_id_resident_id_key RENAME TO resident_statuses_facility_id_resident_id_key;

ALTER TABLE users RENAME CONSTRAINT users_org_id_fkey TO users_facility_id_fkey;
ALTER TABLE kakao_identities RENAME CONSTRAINT kakao_identities_org_id_fkey TO kakao_identities_facility_id_fkey;
ALTER TABLE server_sessions RENAME CONSTRAINT server_sessions_org_id_fkey TO server_sessions_facility_id_fkey;
ALTER TABLE residents RENAME CONSTRAINT residents_org_id_fkey TO residents_facility_id_fkey;
ALTER TABLE guardians RENAME CONSTRAINT guardians_org_id_fkey TO guardians_facility_id_fkey;
ALTER TABLE guardians RENAME CONSTRAINT guardians_org_id_resident_id_fkey TO guardians_facility_id_resident_id_fkey;
ALTER TABLE cameras RENAME CONSTRAINT cameras_org_id_fkey TO cameras_facility_id_fkey;
ALTER TABLE cameras RENAME CONSTRAINT cameras_org_id_resident_id_fkey TO cameras_facility_id_resident_id_fkey;
ALTER TABLE alerts RENAME CONSTRAINT alerts_org_id_fkey TO alerts_facility_id_fkey;
ALTER TABLE alerts RENAME CONSTRAINT alerts_org_id_resident_id_fkey TO alerts_facility_id_resident_id_fkey;
ALTER TABLE alerts RENAME CONSTRAINT alerts_org_id_camera_id_fkey TO alerts_facility_id_camera_id_fkey;
ALTER TABLE resident_statuses RENAME CONSTRAINT resident_statuses_org_id_fkey TO resident_statuses_facility_id_fkey;
ALTER TABLE resident_statuses RENAME CONSTRAINT resident_statuses_org_id_resident_id_fkey TO resident_statuses_facility_id_resident_id_fkey;
ALTER TABLE resident_statuses RENAME CONSTRAINT resident_statuses_org_id_source_id_fkey TO resident_statuses_facility_id_source_id_fkey;

-- Recreate tenant-isolation policies using the facility GUC.
CREATE POLICY tenant_isolation ON residents
  USING     (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);

CREATE POLICY tenant_isolation ON guardians
  USING     (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);

CREATE POLICY tenant_isolation ON cameras
  USING     (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);

CREATE POLICY tenant_isolation ON alerts
  USING     (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);

CREATE POLICY tenant_isolation ON resident_statuses
  USING     (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);

-- SECURITY DEFINER lookup body is stored as text; recreate it for renamed column/output.
DROP FUNCTION IF EXISTS get_camera_for_ingest(TEXT);
CREATE OR REPLACE FUNCTION get_camera_for_ingest(p_key_id TEXT)
RETURNS TABLE(
  id TEXT,
  "facilityId" TEXT,
  "residentId" TEXT,
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
         ingest_key_id AS "ingestKeyId",
         ingest_secret_hash AS "ingestSecretHash"
  FROM cameras
  WHERE ingest_key_id = p_key_id
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_camera_for_ingest(TEXT) TO fall_app;
