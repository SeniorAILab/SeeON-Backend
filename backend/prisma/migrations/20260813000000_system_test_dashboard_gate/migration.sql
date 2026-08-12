-- Facility-level SYSTEM_TEST rows are deliberately outside resident/camera/room semantics.
ALTER TABLE "events"
  ALTER COLUMN "camera_id" DROP NOT NULL,
  ALTER COLUMN "space_id" DROP NOT NULL,
  ADD COLUMN "retention_expires_at" TIMESTAMP(3);

ALTER TABLE "alerts"
  ALTER COLUMN "space_id" DROP NOT NULL,
  ALTER COLUMN "probability" DROP NOT NULL;

ALTER TABLE "edge_validation_grants"
  ADD COLUMN "capability" VARCHAR(32);

ALTER TABLE "edge_validation_grants"
  ADD CONSTRAINT "edge_validation_grants_capability_check"
  CHECK ("capability" IS NULL OR "capability" = 'SYSTEM_TEST');

ALTER TABLE "events"
  ADD CONSTRAINT "events_system_test_shape_check"
  CHECK (
    (
      "type" = 'SYSTEM_TEST'
      AND "camera_id" IS NULL
      AND "space_id" IS NULL
      AND "confidence" IS NULL
      AND "config_version" IS NULL
      AND "model_version" IS NULL
      AND "detector_version" IS NULL
      AND "operating_threshold" IS NULL
      AND "snapshot_key" IS NULL
      AND "clock_source" IS NULL
      AND "clip_id" IS NULL
      AND "validation_run_id" IS NOT NULL
      AND "retention_expires_at" IS NOT NULL
    )
    OR
    (
      "type" <> 'SYSTEM_TEST'
      AND "camera_id" IS NOT NULL
      AND "space_id" IS NOT NULL
      AND "retention_expires_at" IS NULL
    )
  );

ALTER TABLE "alerts"
  ADD CONSTRAINT "alerts_system_test_shape_check"
  CHECK (
    (
      "type" = 'SYSTEM_TEST'
      AND "camera_id" IS NULL
      AND "space_id" IS NULL
      AND "probability" IS NULL
      AND "snapshot_key" IS NULL
    )
    OR
    (
      "type" <> 'SYSTEM_TEST'
      AND "space_id" IS NOT NULL
      AND "probability" IS NOT NULL
    )
  );

CREATE INDEX "events_system_test_retention_idx"
  ON "events"("facility_id", "type", "retention_expires_at");

CREATE TABLE "system_test_purge_audit_history" (
  "receipt_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "facility_id" TEXT NOT NULL,
  "purged_events" INTEGER NOT NULL,
  "purged_alerts" INTEGER NOT NULL,
  "purged_dashboard_receipts" INTEGER NOT NULL,
  "purged_alert_notes" INTEGER NOT NULL,
  "purged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "system_test_purge_audit_history_pkey" PRIMARY KEY ("receipt_id"),
  CONSTRAINT "system_test_purge_audit_counts_check" CHECK (
    "purged_events" > 0
    AND "purged_alerts" >= "purged_events"
    AND "purged_dashboard_receipts" >= 0
    AND "purged_alert_notes" >= 0
  )
);

CREATE UNIQUE INDEX "system_test_purge_audit_history_job_id_key"
  ON "system_test_purge_audit_history"("job_id");
CREATE INDEX "system_test_purge_audit_facility_purged_idx"
  ON "system_test_purge_audit_history"("facility_id", "purged_at");

ALTER TABLE "system_test_purge_audit_history"
  ADD CONSTRAINT "system_test_purge_audit_history_facility_id_fkey"
  FOREIGN KEY ("facility_id") REFERENCES "facilities"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "system_test_purge_audit_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "system_test_purge_audit_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "system_test_purge_audit_history"
  USING ("facility_id" = current_setting('app.facility_id', true)::text)
  WITH CHECK ("facility_id" = current_setting('app.facility_id', true)::text);

REVOKE ALL ON "system_test_purge_audit_history" FROM PUBLIC;
REVOKE ALL ON "system_test_purge_audit_history" FROM fall_app;

CREATE FUNCTION purge_expired_system_tests(
  p_facility_id TEXT,
  p_job_id UUID
)
RETURNS TABLE (
  receipt_id UUID,
  job_id UUID,
  facility_id TEXT,
  purged_events INTEGER,
  purged_alerts INTEGER,
  purged_dashboard_receipts INTEGER,
  purged_alert_notes INTEGER,
  purged_at TIMESTAMP(3),
  replayed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event_ids TEXT[];
  v_alert_ids TEXT[];
  v_purged_events INTEGER := 0;
  v_purged_alerts INTEGER := 0;
  v_purged_dashboard_receipts INTEGER := 0;
  v_purged_alert_notes INTEGER := 0;
  v_database_now TIMESTAMP(3) := transaction_timestamp()::TIMESTAMP(3);
  v_purged_at TIMESTAMP(3);
BEGIN
  IF p_facility_id IS NULL OR btrim(p_facility_id) = '' THEN
    RAISE EXCEPTION 'facility context required' USING ERRCODE = '22023';
  END IF;
  IF current_setting('app.facility_id', true) IS DISTINCT FROM p_facility_id THEN
    RAISE EXCEPTION 'facility context mismatch' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('system-test-retention:' || p_facility_id, 0)
  );

  RETURN QUERY
  SELECT
    audit.receipt_id,
    audit.job_id,
    audit.facility_id,
    audit.purged_events,
    audit.purged_alerts,
    audit.purged_dashboard_receipts,
    audit.purged_alert_notes,
    audit.purged_at,
    TRUE
  FROM public.system_test_purge_audit_history AS audit
  WHERE audit.job_id = p_job_id
    AND audit.facility_id = p_facility_id;
  IF FOUND THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.system_test_purge_audit_history AS audit
    WHERE audit.job_id = p_job_id
  ) THEN
    RAISE EXCEPTION 'job facility mismatch' USING ERRCODE = '23505';
  END IF;

  SELECT
    coalesce(array_agg(candidate.event_id), ARRAY[]::TEXT[]),
    coalesce(array_agg(candidate.alert_id), ARRAY[]::TEXT[])
  INTO v_event_ids, v_alert_ids
  FROM (
    SELECT event_row.id AS event_id, alert_row.id AS alert_id
    FROM public.events AS event_row
    JOIN public.alerts AS alert_row
      ON alert_row.facility_id = event_row.facility_id
     AND alert_row.origin_event_id = event_row.id
     AND alert_row.type = 'SYSTEM_TEST'
     AND alert_row.status = 'RESOLVED'
    JOIN public.edge_validation_grants AS grant_row
      ON grant_row.facility_id = event_row.facility_id
     AND grant_row.id = event_row.validation_run_id
     AND grant_row.capability = 'SYSTEM_TEST'
     AND grant_row.status = 'CLOSED'
    WHERE event_row.facility_id = p_facility_id
      AND event_row.type = 'SYSTEM_TEST'
      AND event_row.retention_expires_at <= v_database_now
    ORDER BY event_row.retention_expires_at, event_row.id
    FOR UPDATE OF event_row, alert_row, grant_row
  ) AS candidate;

  IF cardinality(v_event_ids) = 0 THEN
    RETURN QUERY SELECT
      NULL::UUID,
      p_job_id,
      p_facility_id,
      0,
      0,
      0,
      0,
      NULL::TIMESTAMP(3),
      FALSE;
    RETURN;
  END IF;

  DELETE FROM public.dashboard_receipt_history AS receipt_row
  WHERE receipt_row.facility_id = p_facility_id
    AND receipt_row.backend_event_id = ANY(v_event_ids)
    AND receipt_row.alert_id = ANY(v_alert_ids);
  GET DIAGNOSTICS v_purged_dashboard_receipts = ROW_COUNT;

  DELETE FROM public.alert_notes AS note_row
  WHERE note_row.facility_id = p_facility_id
    AND note_row.alert_id = ANY(v_alert_ids);
  GET DIAGNOSTICS v_purged_alert_notes = ROW_COUNT;

  DELETE FROM public.alerts AS alert_row
  WHERE alert_row.facility_id = p_facility_id
    AND alert_row.id = ANY(v_alert_ids)
    AND alert_row.type = 'SYSTEM_TEST'
    AND alert_row.status = 'RESOLVED';
  GET DIAGNOSTICS v_purged_alerts = ROW_COUNT;

  DELETE FROM public.events AS event_row
  WHERE event_row.facility_id = p_facility_id
    AND event_row.id = ANY(v_event_ids)
    AND event_row.type = 'SYSTEM_TEST'
    AND event_row.retention_expires_at <= v_database_now;
  GET DIAGNOSTICS v_purged_events = ROW_COUNT;

  IF v_purged_events <> cardinality(v_event_ids)
     OR v_purged_alerts <> cardinality(v_alert_ids) THEN
    RAISE EXCEPTION 'SYSTEM_TEST purge cardinality changed'
      USING ERRCODE = '40001';
  END IF;

  v_purged_at := v_database_now;
  INSERT INTO public.system_test_purge_audit_history (
    receipt_id,
    job_id,
    facility_id,
    purged_events,
    purged_alerts,
    purged_dashboard_receipts,
    purged_alert_notes,
    purged_at
  ) VALUES (
    p_job_id,
    p_job_id,
    p_facility_id,
    v_purged_events,
    v_purged_alerts,
    v_purged_dashboard_receipts,
    v_purged_alert_notes,
    v_purged_at
  );

  RETURN QUERY SELECT
    p_job_id,
    p_job_id,
    p_facility_id,
    v_purged_events,
    v_purged_alerts,
    v_purged_dashboard_receipts,
    v_purged_alert_notes,
    v_purged_at,
    FALSE;
END;
$$;

REVOKE ALL ON FUNCTION purge_expired_system_tests(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_system_tests(TEXT, UUID) TO fall_app;
