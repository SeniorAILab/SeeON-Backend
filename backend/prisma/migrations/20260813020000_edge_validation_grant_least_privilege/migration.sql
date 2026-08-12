-- Restrict validation-grant mutation to the runtime lifecycle contract and
-- make every callable in the SECURITY DEFINER purge body explicit.

REVOKE ALL PRIVILEGES ON TABLE public.edge_validation_grants
  FROM PUBLIC, fall_app;
GRANT SELECT, INSERT ON TABLE public.edge_validation_grants TO fall_app;
GRANT UPDATE (status, closed_at)
  ON TABLE public.edge_validation_grants TO fall_app;

-- The purge owner needs UPDATE only because the purge serializes candidate
-- grants with SELECT ... FOR UPDATE. Revoke/regrant to pin that exact matrix.
REVOKE ALL PRIVILEGES ON TABLE public.edge_validation_grants
  FROM system_test_purge_owner;
GRANT SELECT, UPDATE ON TABLE public.edge_validation_grants
  TO system_test_purge_owner;

CREATE OR REPLACE FUNCTION public.purge_expired_system_tests(
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
SET search_path = pg_catalog
AS $$
DECLARE
  v_event_ids TEXT[];
  v_alert_ids TEXT[];
  v_purged_events INTEGER := 0;
  v_purged_alerts INTEGER := 0;
  v_purged_dashboard_receipts INTEGER := 0;
  v_purged_alert_notes INTEGER := 0;
  v_database_now TIMESTAMP(3) :=
    pg_catalog.transaction_timestamp()::TIMESTAMP(3);
  v_purged_at TIMESTAMP(3);
BEGIN
  IF p_facility_id IS NULL
     OR pg_catalog.btrim(p_facility_id) OPERATOR(pg_catalog.=) '' THEN
    RAISE EXCEPTION 'facility context required' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.current_setting('app.facility_id', true)
     IS DISTINCT FROM p_facility_id THEN
    RAISE EXCEPTION 'facility context mismatch' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'system-test-retention:' OPERATOR(pg_catalog.||) p_facility_id,
      0
    )
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
  WHERE audit.job_id OPERATOR(pg_catalog.=) p_job_id
    AND audit.facility_id OPERATOR(pg_catalog.=) p_facility_id;
  IF FOUND THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.system_test_purge_audit_history AS audit
    WHERE audit.job_id OPERATOR(pg_catalog.=) p_job_id
  ) THEN
    RAISE EXCEPTION 'job facility mismatch' USING ERRCODE = '23505';
  END IF;

  SELECT
    pg_catalog.array_agg(candidate.event_id),
    pg_catalog.array_agg(candidate.alert_id)
  INTO v_event_ids, v_alert_ids
  FROM (
    SELECT event_row.id AS event_id, alert_row.id AS alert_id
    FROM public.events AS event_row
    JOIN public.alerts AS alert_row
      ON alert_row.facility_id OPERATOR(pg_catalog.=) event_row.facility_id
     AND alert_row.origin_event_id OPERATOR(pg_catalog.=) event_row.id
     AND alert_row.type OPERATOR(pg_catalog.=) 'SYSTEM_TEST'
     AND alert_row.status OPERATOR(pg_catalog.=) 'RESOLVED'
    JOIN public.edge_validation_grants AS grant_row
      ON grant_row.facility_id OPERATOR(pg_catalog.=) event_row.facility_id
     AND grant_row.id OPERATOR(pg_catalog.=) event_row.validation_run_id
     AND grant_row.capability OPERATOR(pg_catalog.=) 'SYSTEM_TEST'
     AND grant_row.status OPERATOR(pg_catalog.=) 'CLOSED'
    WHERE event_row.facility_id OPERATOR(pg_catalog.=) p_facility_id
      AND event_row.type OPERATOR(pg_catalog.=) 'SYSTEM_TEST'
      AND event_row.retention_expires_at
        OPERATOR(pg_catalog.<=) v_database_now
    ORDER BY event_row.retention_expires_at, event_row.id
    FOR UPDATE OF event_row, alert_row, grant_row
  ) AS candidate;

  IF v_event_ids IS NULL THEN
    v_event_ids := ARRAY[]::TEXT[];
  END IF;
  IF v_alert_ids IS NULL THEN
    v_alert_ids := ARRAY[]::TEXT[];
  END IF;

  IF pg_catalog.cardinality(v_event_ids) OPERATOR(pg_catalog.=) 0 THEN
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
  WHERE receipt_row.facility_id OPERATOR(pg_catalog.=) p_facility_id
    AND receipt_row.backend_event_id OPERATOR(pg_catalog.=) ANY(v_event_ids)
    AND receipt_row.alert_id OPERATOR(pg_catalog.=) ANY(v_alert_ids);
  GET DIAGNOSTICS v_purged_dashboard_receipts = ROW_COUNT;

  DELETE FROM public.alert_notes AS note_row
  WHERE note_row.facility_id OPERATOR(pg_catalog.=) p_facility_id
    AND note_row.alert_id OPERATOR(pg_catalog.=) ANY(v_alert_ids);
  GET DIAGNOSTICS v_purged_alert_notes = ROW_COUNT;

  DELETE FROM public.alerts AS alert_row
  WHERE alert_row.facility_id OPERATOR(pg_catalog.=) p_facility_id
    AND alert_row.id OPERATOR(pg_catalog.=) ANY(v_alert_ids)
    AND alert_row.type OPERATOR(pg_catalog.=) 'SYSTEM_TEST'
    AND alert_row.status OPERATOR(pg_catalog.=) 'RESOLVED';
  GET DIAGNOSTICS v_purged_alerts = ROW_COUNT;

  DELETE FROM public.events AS event_row
  WHERE event_row.facility_id OPERATOR(pg_catalog.=) p_facility_id
    AND event_row.id OPERATOR(pg_catalog.=) ANY(v_event_ids)
    AND event_row.type OPERATOR(pg_catalog.=) 'SYSTEM_TEST'
    AND event_row.retention_expires_at
      OPERATOR(pg_catalog.<=) v_database_now;
  GET DIAGNOSTICS v_purged_events = ROW_COUNT;

  IF v_purged_events
       OPERATOR(pg_catalog.<>) pg_catalog.cardinality(v_event_ids)
     OR v_purged_alerts
       OPERATOR(pg_catalog.<>) pg_catalog.cardinality(v_alert_ids) THEN
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

ALTER FUNCTION public.purge_expired_system_tests(TEXT, UUID)
  OWNER TO system_test_purge_owner;
ALTER FUNCTION public.purge_expired_system_tests(TEXT, UUID)
  SET search_path TO pg_catalog;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.purge_expired_system_tests(TEXT, UUID)
FROM PUBLIC, fall_app;
GRANT EXECUTE ON FUNCTION
  public.purge_expired_system_tests(TEXT, UUID)
TO fall_app;
