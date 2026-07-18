CREATE TYPE "DashboardReceiptKind" AS ENUM ('DELIVERY', 'PRESENTATION');

CREATE UNIQUE INDEX "alerts_facility_id_id_key" ON "alerts"("facility_id", "id");

CREATE TABLE "dashboard_receipt_history" (
    "id" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "dashboard_client_id" VARCHAR(128) NOT NULL,
    "kind" "DashboardReceiptKind" NOT NULL,
    "backend_event_id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "alert_seq" BIGINT NOT NULL,
    "surface" VARCHAR(64) NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_receipt_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dashboard_receipt_history_alert_seq_positive_check" CHECK ("alert_seq" > 0),
    CONSTRAINT "dashboard_receipt_history_client_nonblank_check" CHECK (btrim("dashboard_client_id") <> ''),
    CONSTRAINT "dashboard_receipt_history_surface_nonblank_check" CHECK (btrim("surface") <> '')
);

CREATE UNIQUE INDEX "dashboard_receipt_history_client_kind_alert_seq_surface_key"
    ON "dashboard_receipt_history"("facility_id", "dashboard_client_id", "kind", "alert_id", "alert_seq", "surface");
CREATE INDEX "dashboard_receipt_history_facility_event_created_idx"
    ON "dashboard_receipt_history"("facility_id", "backend_event_id", "created_at");
CREATE INDEX "dashboard_receipt_history_facility_alert_created_idx"
    ON "dashboard_receipt_history"("facility_id", "alert_id", "created_at");

ALTER TABLE "dashboard_receipt_history" ADD CONSTRAINT "dashboard_receipt_history_facility_id_fkey"
    FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dashboard_receipt_history" ADD CONSTRAINT "dashboard_receipt_history_facility_id_backend_event_id_fkey"
    FOREIGN KEY ("facility_id", "backend_event_id") REFERENCES "events"("facility_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dashboard_receipt_history" ADD CONSTRAINT "dashboard_receipt_history_facility_id_alert_id_fkey"
    FOREIGN KEY ("facility_id", "alert_id") REFERENCES "alerts"("facility_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dashboard_receipt_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_receipt_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dashboard_receipt_history"
  USING (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);

REVOKE ALL ON "dashboard_receipt_history" FROM PUBLIC;
GRANT SELECT, INSERT ON "dashboard_receipt_history" TO fall_app;
REVOKE UPDATE, DELETE ON "dashboard_receipt_history" FROM fall_app;
