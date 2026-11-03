-- Runs once on first DB creation (docker-entrypoint-initdb.d).
-- POSTGRES_USER is the owner/migrator (riverbend_migrator). Create the non-owner app role here.
-- app_user has NO BYPASSRLS, so forced row-level security applies to it (D2, Principle III).
CREATE ROLE app_user LOGIN PASSWORD 'app_pw' NOBYPASSRLS;
GRANT CONNECT ON DATABASE riverbend TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;

-- Runtime admin role: cross-shop, used only by the admin/auth module (provisioning, credential
-- lookup). Also NOBYPASSRLS — it reaches other shops via an explicit permissive policy, not a bypass.
CREATE ROLE app_admin LOGIN PASSWORD 'admin_pw' NOBYPASSRLS;
GRANT CONNECT ON DATABASE riverbend TO app_admin;
GRANT USAGE ON SCHEMA public TO app_admin;
-- Table/sequence privileges are granted per-object by migrations (expand-and-contract).
