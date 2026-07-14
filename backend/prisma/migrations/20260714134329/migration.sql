-- CreateIndex
CREATE INDEX "events_facility_id_detected_at_id_idx" ON "events"("facility_id", "detected_at", "id");
-- DropIndex
DROP INDEX "events_facility_id_detected_at_idx";
