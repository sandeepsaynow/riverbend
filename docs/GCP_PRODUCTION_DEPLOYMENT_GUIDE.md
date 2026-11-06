# Riverbend — GCP Deployment Guide (staging & production)

Deploy Riverbend to **your own** GCP project from a clean clone, with no knowledge of this repo's history.
The `make gcp-*` targets wrap one idempotent script (`scripts/gcp/riverbend-gcp.sh`) that encodes the exact
steps verified live on `riverbend-staging` (2026-11-06). Secrets never touch the command line or git.

## 0. Prerequisites

- `gcloud` (authenticated: `gcloud auth login` + `gcloud auth application-default login`), `terraform`,
  `docker`, `psql`, `cloud-sql-proxy`, `openssl`.
- A GCP **project with billing enabled** (use a dedicated project, never an unrelated/production one).
  `make gcp-check` verifies all of this and prints the target + sizing.
- An OpenAI API key (and optionally a Resend key for email).

## 1. Configure (secrets stay local)

```bash
cp scripts/gcp/deploy.env.example scripts/gcp/deploy.staging.env   # GITIGNORED
# edit scripts/gcp/deploy.staging.env → set OPENAI_API_KEY (+ RESEND_API_KEY if using email)
export GCP_PROJECT=<your-project-id>        # or set it as the active gcloud project
make gcp-check ENV=staging                  # account, billing, tools, sizing — review before deploying
```

The script **generates** all signing/auth keys and DB passwords on first deploy and appends them to
`deploy.staging.env` (so re-runs are idempotent). Nothing sensitive is printed or committed.

## 2. Deploy

```bash
make gcp-deploy ENV=staging                 # ~12-15 min (Cloud SQL provisioning is the long pole)
```

This enables the required APIs, creates Artifact Registry, **builds + pushes both images** (app via Cloud
Build, custom LiteLLM via `scripts/gcp/cloudbuild.litellm.yaml`), creates Cloud SQL (sized per `ENV`) with the
`riverbend` + `litellm` databases and the `app_user`(NOBYPASSRLS)/`app_admin`/`litellm_app` roles, loads
Secret Manager, deploys **api** and **worker (+ LiteLLM sidecar)**, makes the **api publicly invokable**
(app-layer auth still enforced), runs **migrations at API boot**, and **provisions the 3 shops**. It prints the
public URL at the end.

Sizing: `ENV=staging` → `db-f1-micro` zonal, api/litellm scale-to-zero, worker min 1 (cheap, disposable).
`ENV=prod` → `db-custom-2-7680` REGIONAL (HA) + backups, warm mins; **`make gcp-deploy ENV=prod CONFIRM=yes`**
is required (review cost first). Staging and prod use the **same script**, different config.

## 3. Bootstrap the first admin (secure, one-time)

```bash
make gcp-bootstrap-admin ENV=staging        # prompts for email + password (hidden; min 12 chars)
```

This reads the single-use bootstrap token from **Secret Manager** (never a URL/log), POSTs `/admin/init` over
HTTPS, and never echoes the password. After the first admin exists, `/admin/init` **permanently returns 409
`already_initialized`** (verified). Wrong/absent token → 401. The admin then creates staff at
`/admin/login → /admin/staff` (roles `SHOP_STAFF`/`SHOP_ADMIN` only — never platform admin, no escalation).

**Lost-admin recovery:** rotate the bootstrap token is *not* enough (bootstrap stays closed). Recover by
promoting an existing user to `role=admin` directly in the DB via the Cloud SQL proxy
(`UPDATE "user" SET role='admin' WHERE email=…`), or reset a password through Better Auth's reset flow. Document
your chosen recovery runbook per environment.

## 4. Verify

```bash
make gcp-test ENV=staging                   # public: /readyz, /f/<shop>, /admin/login = 200;
                                            # /admin/init, /v1 = 401; /staff = 302 (app auth enforced)
```

Then open the printed URL in a normal browser (no GCP account needed), submit a repair request, and watch it
become a catalog-priced work order.

## 5. Teardown

```bash
make gcp-destroy ENV=staging CONFIRM=yes    # deletes Cloud Run services, Cloud SQL, secrets (shows target first)
# or fastest full teardown: gcloud projects delete <project>
```

## 6. Production safety checklist

Before calling an environment production-ready, confirm:

- **IAM least-privilege:** each runtime SA reads only its own secrets (`secretAccessor` per secret) + Cloud
  SQL client; no broad roles. ✅ in the script.
- **Public ingress:** api public + app-layer auth (Better Auth sessions, CSRF double-submit + origin allowlist,
  signed form tokens, `/v1` API keys) — **verified** that public invoker does not bypass authorization.
  Set `WEB_ALLOWED_ORIGINS`/`BETTER_AUTH_URL` to your real (custom-domain) origin.
- **Secure cookies:** `secureCookies=true` in prod (Secure + HttpOnly + SameSite=Lax) — on by `NODE_ENV=production`.
- **Rate/size limits:** submit-rate limiter + body limits in-app; add **Cloud Armor** (in the Terraform LB path)
  for edge WAF/rate-limiting in production.
- **Cloud SQL backup/recovery:** prod profile enables automated backups + PITR; test `gcloud sql backups restore`.
- **Monitoring/alerts:** Cloud Run → Cloud Logging automatically (ids-only, no PII/secrets). Add log-based
  metrics + alerts for 5xx rate, p95 latency, pg-boss backlog, LiteLLM spend (see `docs/not-built.md`).
- **Migrations:** run at API boot (migrate-before-serve); for many instances gate behind a one-shot job.
- **Secret rotation:** add a new Secret Manager version + redeploy (services read `:latest`); rotate DB
  passwords with `gcloud sql users set-password` + a new `database-*` secret version.
- **Terraform remote state:** store state in a **versioned GCS bucket** restricted to the deployer SA; never in git.
- **Rollback:** redeploy the previous image digest (`gcloud run services update … --image <prev>`); Cloud Run
  keeps revisions for instant traffic shift. DB: forward-only corrective migrations in prod.

## 7. Terraform (the HA production shape)

`infra/terraform/` provisions the **LB + custom-domain + Cloud Armor + internal-ingress** production shape
(`terraform fmt`/`validate` green; D27 fixes applied). The `make gcp-*` scripts use a cheaper native-Cloud-Run
shape for fast, disposable staging. Both are documented; pick per environment. Production `terraform apply`
requires a real domain (DNS A record → the LB IP for the managed cert) and is gated behind explicit approval.

## 8. Estimated cost

- **Staging** (this script's defaults): ≈ **$25–35/mo** if left running (Cloud SQL `db-f1-micro` ≈$9 can't
  scale to zero + worker always-on ≈$15–25; api/litellm scale to zero). Same-day test → a few dollars.
- **Production** (HA): Cloud SQL `db-custom-2-7680` REGIONAL ≈$300/mo + warm Cloud Run + LB ≈$20 + Armor ≈$5
  → **≈$400–480/mo**. LLM spend is separate (per-shop $5 LiteLLM team budgets + $15 proxy cap).
