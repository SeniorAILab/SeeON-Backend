-- Delivery attempts become per-recipient idempotent rows for ingest fan-out.
ALTER TABLE "delivery_attempts" ADD COLUMN "recipient_user_id" TEXT;

CREATE UNIQUE INDEX "delivery_attempts_alert_event_id_recipient_user_id_key"
  ON "delivery_attempts"("alert_event_id", "recipient_user_id");

CREATE INDEX "delivery_attempts_recipient_user_id_idx"
  ON "delivery_attempts"("recipient_user_id");

ALTER TABLE "delivery_attempts"
  ADD CONSTRAINT "delivery_attempts_recipient_user_id_fkey"
  FOREIGN KEY ("recipient_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
