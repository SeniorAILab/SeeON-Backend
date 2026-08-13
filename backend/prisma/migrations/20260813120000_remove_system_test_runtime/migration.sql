BEGIN;
SET LOCAL search_path TO pg_catalog;

-- This is a forward-only retirement. Restore from the pre-migration backup or
-- previous application/database image if rollback is required.
--
-- Identify retired rows by the feature's relational shape, not by alert status,
-- age, or a known production id: only SYSTEM_TEST events can have the dedicated
-- retention marker, and every related alert is linked by the composite origin FK.
CREATE TEMP TABLE retired_system_test_events ON COMMIT DROP AS
SELECT event_row.facility_id, event_row.id
FROM public.events AS event_row
WHERE event_row.type OPERATOR(pg_catalog.=) 'SYSTEM_TEST'
   OR event_row.retention_expires_at IS NOT NULL;

CREATE TEMP TABLE retired_system_test_alerts ON COMMIT DROP AS
SELECT alert_row.facility_id, alert_row.id
FROM public.alerts AS alert_row
JOIN retired_system_test_events AS event_row
  ON event_row.facility_id OPERATOR(pg_catalog.=) alert_row.facility_id
 AND event_row.id OPERATOR(pg_catalog.=) alert_row.origin_event_id
WHERE alert_row.type OPERATOR(pg_catalog.=) 'SYSTEM_TEST';

CREATE TEMP TABLE retired_system_test_grants ON COMMIT DROP AS
SELECT grant_row.facility_id, grant_row.id
FROM public.edge_validation_grants AS grant_row
WHERE grant_row.capability OPERATOR(pg_catalog.=) 'SYSTEM_TEST';

DELETE FROM public.event_media_bindings AS binding_row
USING retired_system_test_events AS event_row
WHERE binding_row.facility_id OPERATOR(pg_catalog.=) event_row.facility_id
  AND binding_row.event_id OPERATOR(pg_catalog.=) event_row.id;

DELETE FROM public.dashboard_receipt_history AS receipt_row
USING retired_system_test_events AS event_row,
      retired_system_test_alerts AS alert_row
WHERE receipt_row.facility_id OPERATOR(pg_catalog.=) event_row.facility_id
  AND receipt_row.backend_event_id OPERATOR(pg_catalog.=) event_row.id
  AND receipt_row.facility_id OPERATOR(pg_catalog.=) alert_row.facility_id
  AND receipt_row.alert_id OPERATOR(pg_catalog.=) alert_row.id;

DELETE FROM public.alert_notes AS note_row
USING retired_system_test_alerts AS alert_row
WHERE note_row.facility_id OPERATOR(pg_catalog.=) alert_row.facility_id
  AND note_row.alert_id OPERATOR(pg_catalog.=) alert_row.id;

DELETE FROM public.alerts AS alert_row
USING retired_system_test_alerts AS retired_row
WHERE alert_row.facility_id OPERATOR(pg_catalog.=) retired_row.facility_id
  AND alert_row.id OPERATOR(pg_catalog.=) retired_row.id;

DELETE FROM public.events AS event_row
USING retired_system_test_events AS retired_row
WHERE event_row.facility_id OPERATOR(pg_catalog.=) retired_row.facility_id
  AND event_row.id OPERATOR(pg_catalog.=) retired_row.id;

-- Grants are feature rows only when explicitly capability-marked. Remove them
-- after their linked test events; ordinary validation grants remain intact.
DELETE FROM public.edge_validation_grants AS grant_row
USING retired_system_test_grants AS retired_row
WHERE grant_row.facility_id OPERATOR(pg_catalog.=) retired_row.facility_id
  AND grant_row.id OPERATOR(pg_catalog.=) retired_row.id
  AND NOT EXISTS (
    SELECT 1
    FROM public.events AS event_row
    WHERE event_row.facility_id OPERATOR(pg_catalog.=) grant_row.facility_id
      AND event_row.validation_run_id OPERATOR(pg_catalog.=) grant_row.id
  );

DROP FUNCTION IF EXISTS public.purge_expired_system_tests(TEXT, UUID);
DROP TABLE public.system_test_purge_audit_history;
DROP INDEX public.events_system_test_retention_idx;

ALTER TABLE public.events
  DROP CONSTRAINT events_system_test_shape_check;
ALTER TABLE public.alerts
  DROP CONSTRAINT alerts_system_test_shape_check;
ALTER TABLE public.edge_validation_grants
  DROP CONSTRAINT edge_validation_grants_capability_check;

ALTER TABLE public.events
  DROP COLUMN retention_expires_at,
  ALTER COLUMN camera_id SET NOT NULL,
  ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE public.alerts
  ALTER COLUMN space_id SET NOT NULL,
  ALTER COLUMN probability SET NOT NULL;
ALTER TABLE public.edge_validation_grants
  DROP COLUMN capability;

-- Migrations 47/48 narrowed runtime privileges while introducing the purge
-- owner. Preserve those least-privilege grants; remove only feature-owned ACLs.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM system_test_purge_owner;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
  FROM system_test_purge_owner;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM system_test_purge_owner;
DROP ROLE system_test_purge_owner;

COMMIT;
