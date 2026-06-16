-- Create dedicated runtime app role: NOSUPERUSER NOBYPASSRLS
-- This role is used by the application (DATABASE_URL) at runtime.
-- The 'fall' superuser is used only for migrations and seeding (DIRECT_URL).
--
-- NOTE: This file runs ONLY on first Postgres initialization (docker-entrypoint-initdb.d).
-- If the volume already exists, drop it with `docker compose down -v` first.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fall_app') THEN
    CREATE ROLE fall_app WITH
      LOGIN
      PASSWORD 'fall_app'
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION;
  END IF;
END $$;

-- Grant connection access (table-level grants are applied after migration)
GRANT CONNECT ON DATABASE fall_dev TO fall_app;
GRANT USAGE ON SCHEMA public TO fall_app;
