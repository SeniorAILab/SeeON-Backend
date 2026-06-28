-- Alert acknowledgement→resolution lifecycle audit columns.
-- Adds nullable actor/timestamp columns for the NEW→ACKED→RESOLVED lifecycle.
-- `alerts` already has ENABLE/FORCE RLS + tenant policy on facility_id; these new
-- columns inherit the existing table policy, so no new RLS policy is required.

-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "acked_at" TIMESTAMP(3),
ADD COLUMN     "acked_by_id" TEXT,
ADD COLUMN     "resolved_at" TIMESTAMP(3),
ADD COLUMN     "resolved_by_id" TEXT;

-- CreateIndex
CREATE INDEX "alerts_facility_id_status_alert_seq_idx" ON "alerts"("facility_id", "status", "alert_seq");

-- CreateIndex
CREATE INDEX "alerts_acked_by_id_idx" ON "alerts"("acked_by_id");

-- CreateIndex
CREATE INDEX "alerts_resolved_by_id_idx" ON "alerts"("resolved_by_id");

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acked_by_id_fkey" FOREIGN KEY ("acked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
