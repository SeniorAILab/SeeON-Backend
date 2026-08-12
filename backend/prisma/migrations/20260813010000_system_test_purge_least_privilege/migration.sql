-- Close the runtime-role retention bypass without changing normal Alert flows.
-- The application may create/read Alerts and update only lifecycle/snapshot
-- columns. Retention deletes remain available exclusively through the audited
-- SECURITY DEFINER function owned by a dedicated NOLOGIN role.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'system_test_purge_owner'
  ) THEN
    CREATE ROLE system_test_purge_owner WITH
      NOLOGIN
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOINHERIT;
  END IF;
END
$$;

ALTER ROLE system_test_purge_owner WITH
  NOLOGIN
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOINHERIT;

-- Remove table-wide mutation inherited from the original application grants,
-- then restore only privileges exercised by normal runtime code.
REVOKE ALL PRIVILEGES ON TABLE public.alerts FROM PUBLIC, fall_app;
GRANT SELECT, INSERT ON TABLE public.alerts TO fall_app;
GRANT UPDATE (
  status,
  acked_by_id,
  acked_at,
  resolved_by_id,
  resolved_at,
  snapshot_key
) ON TABLE public.alerts TO fall_app;

REVOKE ALL PRIVILEGES ON TABLE public.alert_notes FROM PUBLIC, fall_app;
GRANT SELECT, INSERT ON TABLE public.alert_notes TO fall_app;

REVOKE ALL PRIVILEGES ON TABLE public.dashboard_receipt_history FROM PUBLIC, fall_app;
GRANT SELECT, INSERT ON TABLE public.dashboard_receipt_history TO fall_app;

REVOKE ALL PRIVILEGES ON TABLE public.events FROM PUBLIC, fall_app;
GRANT SELECT, INSERT ON TABLE public.events TO fall_app;

REVOKE ALL PRIVILEGES ON TABLE public.event_media_bindings FROM PUBLIC, fall_app;
GRANT SELECT, INSERT ON TABLE public.event_media_bindings TO fall_app;

REVOKE ALL PRIVILEGES ON TABLE public.system_test_purge_audit_history
  FROM PUBLIC, fall_app;

-- A dedicated owner receives only the data privileges required by the fixed
-- purge body. It cannot log in, bypass RLS, create roles/databases, or inherit
-- privileges from another role.
GRANT USAGE ON SCHEMA public TO system_test_purge_owner;
GRANT SELECT, UPDATE, DELETE ON TABLE
  public.events,
  public.alerts
TO system_test_purge_owner;
GRANT SELECT, DELETE ON TABLE
  public.alert_notes,
  public.dashboard_receipt_history
TO system_test_purge_owner;
-- UPDATE is required by PostgreSQL for SELECT ... FOR UPDATE row locks.
GRANT SELECT, UPDATE ON TABLE public.edge_validation_grants
  TO system_test_purge_owner;
GRANT SELECT, INSERT ON TABLE public.system_test_purge_audit_history
  TO system_test_purge_owner;

-- Ownership transfer requires CREATE on the containing schema. Remove it
-- immediately after the transfer so the owner cannot create new entry points.
GRANT CREATE ON SCHEMA public TO system_test_purge_owner;
ALTER FUNCTION public.purge_expired_system_tests(TEXT, UUID)
  OWNER TO system_test_purge_owner;
REVOKE CREATE ON SCHEMA public FROM system_test_purge_owner;

ALTER FUNCTION public.purge_expired_system_tests(TEXT, UUID)
  SET search_path TO pg_catalog;

REVOKE ALL PRIVILEGES ON FUNCTION
  public.purge_expired_system_tests(TEXT, UUID)
FROM PUBLIC, fall_app;
GRANT EXECUTE ON FUNCTION
  public.purge_expired_system_tests(TEXT, UUID)
TO fall_app;
