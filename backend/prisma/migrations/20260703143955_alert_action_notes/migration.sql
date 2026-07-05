-- CreateTable
CREATE TABLE "alert_notes" (
    "id" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "created_by_id" TEXT,
    "author_role" "Role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_notes_facility_id_alert_id_created_at_idx" ON "alert_notes"("facility_id", "alert_id", "created_at");

-- CreateIndex
CREATE INDEX "alert_notes_alert_id_idx" ON "alert_notes"("alert_id");

-- CreateIndex
CREATE INDEX "alert_notes_created_by_id_idx" ON "alert_notes"("created_by_id");

-- AddForeignKey
ALTER TABLE "alert_notes" ADD CONSTRAINT "alert_notes_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_notes" ADD CONSTRAINT "alert_notes_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_notes" ADD CONSTRAINT "alert_notes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "alert_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alert_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "alert_notes"
  USING     (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);

GRANT SELECT, INSERT, UPDATE, DELETE ON "alert_notes" TO fall_app;

