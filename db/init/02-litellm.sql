-- Isolated database + restricted role for the LiteLLM proxy's own persistence (budget authority,
-- 2.0.0). Separate from the Riverbend `riverbend` database and from the app roles — the proxy manages
-- its own schema (teams, keys, spend) via Prisma. Local dev credentials only.
CREATE ROLE litellm_app LOGIN PASSWORD 'litellm_pw' NOBYPASSRLS;
CREATE DATABASE litellm OWNER litellm_app;
