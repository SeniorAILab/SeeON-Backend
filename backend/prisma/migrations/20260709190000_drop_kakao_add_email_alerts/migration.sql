-- Remove the Kakao identity subsystem and switch alert delivery to email.
--
-- Kakao OAuth login and send-to-me delivery are retired. Alerts now fan out to
-- admin recipients over SMTP email (users.notification_email ?? users.email),
-- gated by users.email_alerts_enabled.

-- 1) DeliveryChannel enum: rename the single value in place so existing
--    delivery_attempts rows are preserved (no cast/backfill needed).
ALTER TYPE "DeliveryChannel" RENAME VALUE 'KAKAO_SEND_TO_ME' TO 'EMAIL';

-- 2) Drop the Kakao OAuth identity table (FKs to users/facilities drop with it).
DROP TABLE "kakao_identities";

-- 3) Drop users.kakao_id (its unique index drops with the column) and add the
--    email-alert recipient columns.
ALTER TABLE "users" DROP COLUMN "kakao_id";
ALTER TABLE "users" ADD COLUMN "notification_email" TEXT;
ALTER TABLE "users" ADD COLUMN "email_alerts_enabled" BOOLEAN NOT NULL DEFAULT true;
