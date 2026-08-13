BEGIN;
SET LOCAL search_path TO pg_catalog;

-- Migration 50 is a zero-overlap cutover. Lock every retired write surface so
-- no drained old backend can race the precondition checks and destructive DDL.
LOCK TABLE public.events,
  public.edge_validation_grants,
  public.edge_admin_operations,
  public.edge_provisioning_audit_history
  IN ACCESS EXCLUSIVE MODE;

DO $migration50$
DECLARE
  grant_rows BIGINT;
  linked_event_rows BIGINT;
  create_operation_rows BIGINT;
  close_operation_rows BIGINT;
  created_audit_rows BIGINT;
  closed_audit_rows BIGINT;
  deleted_rows BIGINT;
  expected_operation_rows BIGINT;
  expected_audit_rows BIGINT;
BEGIN
  SELECT pg_catalog.count(*) INTO grant_rows
  FROM public.edge_validation_grants;
  SELECT pg_catalog.count(*) INTO linked_event_rows
  FROM public.events
  WHERE validation_run_id IS NOT NULL;

  IF grant_rows OPERATOR(pg_catalog.<>) 0
     OR linked_event_rows OPERATOR(pg_catalog.<>) 0 THEN
    RAISE EXCEPTION
      'migration 50 precondition failed: edge_validation_grants=%, validation-linked events=%; fully drain the old backend and remove retired data before retrying',
      grant_rows,
      linked_event_rows;
  END IF;

  SELECT pg_catalog.count(*) INTO create_operation_rows
  FROM public.edge_admin_operations
  WHERE operation_type OPERATOR(pg_catalog.=) 'VALIDATION_RUN';
  SELECT pg_catalog.count(*) INTO close_operation_rows
  FROM public.edge_admin_operations
  WHERE operation_type OPERATOR(pg_catalog.=) 'VALIDATION_RUN_CLOSE';

  -- A fresh full-chain database has no runtime history. The production-shaped
  -- path must contain exactly the two create and two close rows observed before
  -- cutover; any partial or extra set is an unsafe discriminator mismatch.
  IF create_operation_rows OPERATOR(pg_catalog.=) 0
     AND close_operation_rows OPERATOR(pg_catalog.=) 0 THEN
    expected_operation_rows := 0;
  ELSIF create_operation_rows OPERATOR(pg_catalog.=) 2
        AND close_operation_rows OPERATOR(pg_catalog.=) 2 THEN
    expected_operation_rows := 4;
  ELSE
    RAISE EXCEPTION
      'migration 50 operation history precondition failed: VALIDATION_RUN=%, VALIDATION_RUN_CLOSE=%',
      create_operation_rows,
      close_operation_rows;
  END IF;

  SELECT pg_catalog.count(*) INTO created_audit_rows
  FROM public.edge_provisioning_audit_history
  WHERE action OPERATOR(pg_catalog.=) 'VALIDATION_RUN_CREATED';
  SELECT pg_catalog.count(*) INTO closed_audit_rows
  FROM public.edge_provisioning_audit_history
  WHERE action OPERATOR(pg_catalog.=) 'VALIDATION_RUN_CLOSED';

  IF created_audit_rows OPERATOR(pg_catalog.=) 0
     AND closed_audit_rows OPERATOR(pg_catalog.=) 0 THEN
    expected_audit_rows := 0;
  ELSIF created_audit_rows OPERATOR(pg_catalog.=) 2
        AND closed_audit_rows OPERATOR(pg_catalog.=) 2 THEN
    expected_audit_rows := 4;
  ELSE
    RAISE EXCEPTION
      'migration 50 audit history precondition failed: VALIDATION_RUN_CREATED=%, VALIDATION_RUN_CLOSED=%',
      created_audit_rows,
      closed_audit_rows;
  END IF;

  DELETE FROM public.edge_admin_operations
  WHERE operation_type IN ('VALIDATION_RUN', 'VALIDATION_RUN_CLOSE');
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  IF deleted_rows OPERATOR(pg_catalog.<>) expected_operation_rows THEN
    RAISE EXCEPTION
      'migration 50 operation history cardinality changed: expected %, deleted %',
      expected_operation_rows,
      deleted_rows;
  END IF;

  DELETE FROM public.edge_provisioning_audit_history
  WHERE action IN ('VALIDATION_RUN_CREATED', 'VALIDATION_RUN_CLOSED');
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  IF deleted_rows OPERATOR(pg_catalog.<>) expected_audit_rows THEN
    RAISE EXCEPTION
      'migration 50 audit history cardinality changed: expected %, deleted %',
      expected_audit_rows,
      deleted_rows;
  END IF;
END
$migration50$;

ALTER TABLE public.events
  DROP CONSTRAINT events_facility_id_validation_run_id_fkey;
DROP INDEX public.events_facility_id_validation_run_id_idx;
ALTER TABLE public.events
  DROP COLUMN validation_run_id;

-- Remove feature-specific policy and ACL state explicitly before dropping the
-- table; ordinary Event/Alert RLS, ACLs, indexes, and foreign keys are untouched.
DROP POLICY tenant_isolation ON public.edge_validation_grants;
REVOKE ALL PRIVILEGES ON TABLE public.edge_validation_grants FROM fall_app;
REVOKE ALL PRIVILEGES ON TABLE public.edge_validation_grants FROM PUBLIC;
DROP TABLE public.edge_validation_grants;
DROP TYPE public."EdgeValidationGrantStatus";

-- Migration 49 already removed this role. IF EXISTS makes full-chain replay
-- explicit while still removing an unexpectedly surviving dependency-free role.
DROP ROLE IF EXISTS system_test_purge_owner;

COMMIT;
