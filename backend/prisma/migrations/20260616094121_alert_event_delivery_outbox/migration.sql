-- CreateEnum
CREATE TYPE "AlertEventType" AS ENUM ('FALL', 'DETECTION_LOST');

-- CreateEnum
CREATE TYPE "AlertDecision" AS ENUM ('DISPATCH', 'SUPPRESS');

-- CreateEnum
CREATE TYPE "AlertSuppressedReason" AS ENUM ('COOLDOWN', 'HOURLY_CAP', 'BELOW_THRESHOLD');

-- CreateEnum
CREATE TYPE "DeliveryChannel" AS ENUM ('KAKAO_SEND_TO_ME');

-- CreateEnum
CREATE TYPE "DeliveryAttemptStatus" AS ENUM ('PENDING', 'SENT', 'RETRY_SCHEDULED', 'TERMINAL_FAILED');

-- CreateEnum
CREATE TYPE "DeliveryFailureClass" AS ENUM ('TRANSIENT', 'TERMINAL_OPERATOR_ACTION');

-- CreateTable
CREATE TABLE "alert_events" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "type" "AlertEventType" NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL,
    "confidence" DOUBLE PRECISION,
    "fall_probability" DOUBLE PRECISION,
    "operating_threshold" DOUBLE PRECISION,
    "decision" "AlertDecision" NOT NULL,
    "suppressed_reason" "AlertSuppressedReason",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" TEXT NOT NULL,
    "alert_event_id" TEXT NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "status" "DeliveryAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "provider_reference" TEXT,
    "failure_class" "DeliveryFailureClass",
    "terminal_reason" TEXT,
    "operator_action" TEXT,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_events_detected_at_idx" ON "alert_events"("detected_at");

-- CreateIndex
CREATE UNIQUE INDEX "alert_events_source_id_external_event_id_key" ON "alert_events"("source_id", "external_event_id");

-- CreateIndex
CREATE INDEX "delivery_attempts_status_next_attempt_at_idx" ON "delivery_attempts"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "delivery_attempts_alert_event_id_idx" ON "delivery_attempts"("alert_event_id");

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_alert_event_id_fkey" FOREIGN KEY ("alert_event_id") REFERENCES "alert_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
