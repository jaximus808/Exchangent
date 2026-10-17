-- Minimal stand-ins for what InsForge provides, so migrations apply to plain postgres:16.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY);
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['project_admin','anon','authenticated'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',r); END IF;
 END LOOP;
END $$;
