-- AlterTable
ALTER TABLE "events" ADD COLUMN "validation_run_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "edge_validation_grants_facility_id_id_key" ON "edge_validation_grants"("facility_id", "id");

-- CreateIndex
CREATE INDEX "events_facility_id_validation_run_id_idx" ON "events"("facility_id", "validation_run_id");

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_facility_id_validation_run_id_fkey" FOREIGN KEY ("facility_id", "validation_run_id") REFERENCES "edge_validation_grants"("facility_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
