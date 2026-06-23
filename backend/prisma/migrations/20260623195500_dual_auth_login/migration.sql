ALTER TABLE "users" ALTER COLUMN "kakao_id" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
