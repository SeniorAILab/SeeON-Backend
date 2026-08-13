BEGIN;
SET LOCAL search_path TO pg_catalog;

-- Fail closed on cluster-global role drift. Memberships are never revoked here
-- because this migration cannot know whether another database depends on them.
-- system_test_purge_owner membership gate: begin
DO $$
DECLARE
  v_owner_oid pg_catalog.oid;
  v_owner_can_login BOOLEAN;
BEGIN
  SELECT role_row.oid, role_row.rolcanlogin
  INTO v_owner_oid, v_owner_can_login
  FROM pg_catalog.pg_roles AS role_row
  WHERE role_row.rolname OPERATOR(pg_catalog.=) 'system_test_purge_owner';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'system_test_purge_owner role is required'
      USING ERRCODE = '55000';
  END IF;
  IF v_owner_can_login THEN
    RAISE EXCEPTION 'system_test_purge_owner must be NOLOGIN'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid OPERATOR(pg_catalog.=) v_owner_oid
       OR membership.member OPERATOR(pg_catalog.=) v_owner_oid
  ) THEN
    RAISE EXCEPTION
      'system_test_purge_owner must have zero role memberships'
      USING ERRCODE = '55000';
  END IF;
END
$$;
-- system_test_purge_owner membership gate: end

-- These policies expose rows only to the isolated NOLOGIN function owner.
-- They do not alter fall_app tenant isolation or grant any login role access.
CREATE POLICY system_test_purge_owner_event_select
  ON public.events
  FOR SELECT
  TO system_test_purge_owner
  USING (true);
CREATE POLICY system_test_purge_owner_binding_select
  ON public.event_media_bindings
  FOR SELECT
  TO system_test_purge_owner
  USING (true);

GRANT SELECT, DELETE ON TABLE public.event_media_bindings
  TO system_test_purge_owner;

CREATE FUNCTION public.reject_system_test_event_media_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.events AS event_row
    WHERE event_row.facility_id
            OPERATOR(pg_catalog.=) NEW.facility_id
      AND event_row.id OPERATOR(pg_catalog.=) NEW.event_id
      AND event_row.type OPERATOR(pg_catalog.=) 'SYSTEM_TEST'
  ) THEN
    RAISE EXCEPTION 'SYSTEM_TEST event media binding forbidden'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'event_media_bindings_system_test_event_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reject_system_test_event_with_media_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.type OPERATOR(pg_catalog.=) 'SYSTEM_TEST'
     AND EXISTS (
       SELECT 1
       FROM public.event_media_bindings AS binding_row
       WHERE binding_row.facility_id
               OPERATOR(pg_catalog.=) NEW.facility_id
         AND binding_row.event_id OPERATOR(pg_catalog.=) NEW.id
     ) THEN
    RAISE EXCEPTION 'SYSTEM_TEST event media binding forbidden'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'event_media_bindings_system_test_event_check';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION
  public.reject_system_test_event_media_binding()
FROM PUBLIC, fall_app;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.reject_system_test_event_with_media_binding()
FROM PUBLIC, fall_app;

GRANT CREATE ON SCHEMA public TO system_test_purge_owner;
ALTER FUNCTION public.reject_system_test_event_media_binding()
  OWNER TO system_test_purge_owner;
ALTER FUNCTION public.reject_system_test_event_with_media_binding()
  OWNER TO system_test_purge_owner;
REVOKE CREATE ON SCHEMA public FROM system_test_purge_owner;

CREATE TRIGGER reject_system_test_event_media_binding
BEFORE INSERT OR UPDATE OF event_id, facility_id
ON public.event_media_bindings
FOR EACH ROW
EXECUTE FUNCTION public.reject_system_test_event_media_binding();

CREATE TRIGGER reject_system_test_event_with_media_binding
BEFORE UPDATE OF type
ON public.events
FOR EACH ROW
EXECUTE FUNCTION public.reject_system_test_event_with_media_binding();

-- Keep the published receipt and return shape unchanged. Bindings are an
-- internal dependency deleted atomically before their SYSTEM_TEST event.
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

  DELETE FROM public.event_media_bindings AS binding_row
  WHERE binding_row.facility_id OPERATOR(pg_catalog.=) p_facility_id
    AND binding_row.event_id OPERATOR(pg_catalog.=) ANY(v_event_ids);

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

COMMIT;
