-- The v0.x release deploy performs a full database wipe and reseed, so events is
-- empty and these plain index operations have no production lock window. Future
-- live-table index changes must use CREATE/DROP INDEX CONCURRENTLY in a
-- non-transactional Prisma migration.
-- CreateIndex
CREATE INDEX "events_facility_id_detected_at_id_idx" ON "events"("facility_id", "detected_at", "id");
-- DropIndex
DROP INDEX "events_facility_id_detected_at_idx";
