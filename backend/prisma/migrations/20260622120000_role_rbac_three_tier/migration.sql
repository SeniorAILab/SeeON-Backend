-- Replace two-tier Role enum with SUPER_ADMIN | ADMIN | CAREGIVER.
-- Postgres cannot remove enum variants in place, so rebuild the type and cast existing rows.
-- Existing OWNER users are mapped to ADMIN. Existing sessions are revoked and user
-- session versions are bumped so old role-bearing tokens must re-login.

ALTER TABLE users ALTER COLUMN role DROP DEFAULT;

ALTER TYPE "Role" RENAME TO "Role_old";
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'CAREGIVER');

ALTER TABLE users
  ALTER COLUMN role TYPE "Role"
  USING (
    CASE role::text
      WHEN 'OWNER' THEN 'ADMIN'
      WHEN 'ADMIN' THEN 'ADMIN'
      ELSE 'ADMIN'
    END
  )::"Role";

ALTER TABLE users ALTER COLUMN role SET DEFAULT 'ADMIN';

DROP TYPE "Role_old";

-- Force re-login for every pre-migration personal session because tokens created
-- before this migration may carry now-obsolete role semantics.
UPDATE users
SET session_version = session_version + 1;

UPDATE server_sessions
SET revoked_at = CURRENT_TIMESTAMP
WHERE revoked_at IS NULL;
