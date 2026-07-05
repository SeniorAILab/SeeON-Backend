-- Drop the resident domain. v1 monitors at room (space) granularity only:
-- residents, guardians, resident assignments, and the resident status read
-- model are out of scope until v2. Alerts are keyed by space/room, not resident.

BEGIN;

-- DropForeignKey: alert -> resident must go before the residents table is dropped.
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_facility_id_resident_id_fkey;

-- DropTable: drop children that reference residents first, then residents.
DROP TABLE guardians;
DROP TABLE resident_assignments;
DROP TABLE resident_statuses;
DROP TABLE residents;

-- AlterTable: alerts no longer carry a resident reference.
ALTER TABLE alerts DROP COLUMN resident_id;

-- DropEnum: only referenced by the dropped resident domain.
DROP TYPE "ResidentState";
DROP TYPE "Level";

COMMIT;
