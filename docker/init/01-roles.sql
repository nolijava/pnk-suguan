-- Non-owner database roles (least privilege). Runs once on first container init.
-- p nk_migrate: owns the schema and runs migrations (DDL). No BYPASSRLS.
-- pnk_app:      runtime role used by the application. DML only, no DDL, no BYPASSRLS.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pnk_migrate') THEN
    CREATE ROLE pnk_migrate LOGIN PASSWORD 'CHANGE_ME_MIGRATE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pnk_app') THEN
    CREATE ROLE pnk_app LOGIN PASSWORD 'CHANGE_ME_APP';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE pnk TO pnk_migrate, pnk_app;
