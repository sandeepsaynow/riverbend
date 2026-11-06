#!/usr/bin/env bash
# Riverbend GCP deploy automation (D28). One idempotent script, several subcommands, driven by the Makefile
# `gcp-*` targets. Encodes the EXACT steps proven on riverbend-staging 2026-11-06 so anyone can reproduce a
# deploy on their own project without knowing this repo's history.
#
#   ENV=staging|prod   (sizing profile; prod apply is gated behind CONFIRM=yes)
#   GCP_PROJECT        (target project id; defaults to the active gcloud project)
#   REGION             (default us-central1)
#
# Secret VALUES are read from scripts/gcp/deploy.<ENV>.env (gitignored) — never from the command line, so
# nothing sensitive lands in shell history or CI logs. Signing/auth keys are GENERATED, not committed.
set -euo pipefail

CMD="${1:-help}"
ENVNAME="${ENV:-staging}"
REGION="${REGION:-us-central1}"
PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REPO="riverbend"
INSTANCE="riverbend-pg"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRET_ENV="$ROOT/scripts/gcp/deploy.${ENVNAME}.env"
CONN="${PROJECT}:${REGION}:${INSTANCE}"
AR="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"
PROTECTED_PROJECTS="virool"   # never deploy/destroy here
PXPORT=6543

if [ "$ENVNAME" = "prod" ]; then
  DB_TIER="db-custom-2-7680"; DB_AVAIL="REGIONAL"; DB_BACKUP=""
  API_MIN=1; LITELLM_MIN=1; WORKER_MIN=1
else
  DB_TIER="db-f1-micro"; DB_AVAIL="ZONAL"; DB_BACKUP="--no-backup"
  API_MIN=0; LITELLM_MIN=0; WORKER_MIN=1
fi

die() { echo "ERROR: $*" >&2; exit 1; }
guard_project() {
  [ -n "$PROJECT" ] || die "no GCP_PROJECT and no active gcloud project"
  for p in $PROTECTED_PROJECTS; do if [ "$PROJECT" = "$p" ]; then die "refusing to operate on protected project '$p'"; fi; done
}
load_secrets() { [ -f "$SECRET_ENV" ] || die "missing $SECRET_ENV (copy scripts/gcp/deploy.env.example and fill OPENAI_API_KEY etc.)"; set -a; . "$SECRET_ENV"; set +a; }
sm() { if gcloud secrets describe "$1" --project="$PROJECT" >/dev/null 2>&1; then printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project="$PROJECT" >/dev/null; else printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic --project="$PROJECT" >/dev/null; fi; }
grant() { gcloud secrets add-iam-policy-binding "$1" --member="serviceAccount:$2@${PROJECT}.iam.gserviceaccount.com" --role=roles/secretmanager.secretAccessor --project="$PROJECT" >/dev/null 2>&1 || true; }
apiurl() { gcloud run services describe rb-api --region "$REGION" --project "$PROJECT" --format='value(status.url)' 2>/dev/null; }
rand() { openssl rand -base64 18 | tr -d '/+=' | head -c 24; }
proxy_up() { cloud-sql-proxy --port "$PXPORT" "$CONN" >/tmp/rb-gcp-proxy.log 2>&1 & echo $! >/tmp/rb-gcp-proxy.pid; sleep 6; }
proxy_down() { [ -f /tmp/rb-gcp-proxy.pid ] && kill "$(cat /tmp/rb-gcp-proxy.pid)" 2>/dev/null || true; rm -f /tmp/rb-gcp-proxy.pid; }

cmd_check() {
  guard_project
  echo "== gcp-check =="
  echo "  account : $(gcloud config get-value account 2>/dev/null)"
  echo "  project : $PROJECT   region: $REGION   ENV: $ENVNAME"
  echo "  billing : $(gcloud beta billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || echo unknown)"
  echo "  db tier : $DB_TIER ($DB_AVAIL)   run mins: api=$API_MIN litellm=$LITELLM_MIN worker=$WORKER_MIN"
  for t in gcloud terraform docker psql cloud-sql-proxy openssl; do command -v "$t" >/dev/null 2>&1 && echo "  tool ok : $t" || echo "  MISSING : $t"; done
  [ -f "$SECRET_ENV" ] && echo "  secrets : $SECRET_ENV present" || echo "  secrets : $SECRET_ENV MISSING (copy scripts/gcp/deploy.env.example)"
}

cmd_deploy() {
  guard_project; load_secrets
  [ "$ENVNAME" = "prod" ] && [ "${CONFIRM:-}" != "yes" ] && die "prod deploy requires CONFIRM=yes (review sizing/cost first)"
  echo "== gcp-deploy ENV=$ENVNAME project=$PROJECT =="
  echo "-- APIs --"; gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com iam.googleapis.com --project="$PROJECT"
  echo "-- Artifact Registry --"; gcloud artifacts repositories describe "$REPO" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1 || gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" --project="$PROJECT"
  echo "-- build images (Cloud Build) --"
  gcloud builds submit --tag "$AR/app:latest" --project="$PROJECT" "$ROOT"
  gcloud builds submit --config "$ROOT/scripts/gcp/cloudbuild.litellm.yaml" --substitutions _AR="$AR" --project="$PROJECT" "$ROOT"
  APP_IMG="$AR/app:latest"; LLM_IMG="$AR/litellm:latest"
  echo "-- service accounts --"; for sa in rb-api rb-worker rb-litellm; do gcloud iam service-accounts describe "$sa@${PROJECT}.iam.gserviceaccount.com" --project="$PROJECT" >/dev/null 2>&1 || gcloud iam service-accounts create "$sa" --project="$PROJECT"; done
  echo "-- Cloud SQL ($DB_TIER) --"
  if ! gcloud sql instances describe "$INSTANCE" --project="$PROJECT" >/dev/null 2>&1; then
    PG_ROOT_PW="$(rand)"; echo "PG_ROOT_PW=$PG_ROOT_PW" >>"$SECRET_ENV"
    gcloud sql instances create "$INSTANCE" --database-version=POSTGRES_16 --edition=ENTERPRISE --tier="$DB_TIER" --region="$REGION" --availability-type="$DB_AVAIL" --database-flags max_connections=60 $DB_BACKUP --storage-size=10 --storage-type=HDD --root-password="$PG_ROOT_PW" --project="$PROJECT"
  fi
  : "${PG_ROOT_PW:?set PG_ROOT_PW in $SECRET_ENV}"
  gcloud sql databases describe riverbend --instance="$INSTANCE" --project="$PROJECT" >/dev/null 2>&1 || gcloud sql databases create riverbend --instance="$INSTANCE" --project="$PROJECT"
  gcloud sql databases describe litellm   --instance="$INSTANCE" --project="$PROJECT" >/dev/null 2>&1 || gcloud sql databases create litellm   --instance="$INSTANCE" --project="$PROJECT"
  APP_PW="${APP_PW:-$(rand)}"; ADMIN_PW="${ADMIN_PW:-$(rand)}"; LITELLM_DB_PW="${LITELLM_DB_PW:-$(rand)}"
  grep -q '^APP_PW=' "$SECRET_ENV" || echo "APP_PW=$APP_PW" >>"$SECRET_ENV"; grep -q '^ADMIN_PW=' "$SECRET_ENV" || echo "ADMIN_PW=$ADMIN_PW" >>"$SECRET_ENV"; grep -q '^LITELLM_DB_PW=' "$SECRET_ENV" || echo "LITELLM_DB_PW=$LITELLM_DB_PW" >>"$SECRET_ENV"
  gcloud sql users describe app_user --instance="$INSTANCE" --project="$PROJECT" >/dev/null 2>&1 || gcloud sql users create app_user --instance="$INSTANCE" --password="$APP_PW" --project="$PROJECT"
  gcloud sql users describe app_admin --instance="$INSTANCE" --project="$PROJECT" >/dev/null 2>&1 || gcloud sql users create app_admin --instance="$INSTANCE" --password="$ADMIN_PW" --project="$PROJECT"
  echo "-- DB roles/grants (via proxy) --"; proxy_up
  PGPASSWORD="$PG_ROOT_PW" psql "host=127.0.0.1 port=$PXPORT user=postgres dbname=postgres sslmode=disable" -v ON_ERROR_STOP=0 \
    -c "DO \$\$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='litellm_app') THEN CREATE ROLE litellm_app LOGIN PASSWORD '$LITELLM_DB_PW' NOBYPASSRLS; END IF; END\$\$;" \
    -c "ALTER ROLE litellm_app PASSWORD '$LITELLM_DB_PW';" -c "GRANT litellm_app TO postgres;" >/dev/null 2>&1 || true
  PGPASSWORD="$PG_ROOT_PW" psql "host=127.0.0.1 port=$PXPORT user=postgres dbname=riverbend sslmode=disable" \
    -c "GRANT CONNECT ON DATABASE riverbend TO app_user, app_admin;" -c "GRANT USAGE ON SCHEMA public TO app_user, app_admin;" >/dev/null 2>&1 || true
  PGPASSWORD="$PG_ROOT_PW" psql "host=127.0.0.1 port=$PXPORT user=postgres dbname=litellm sslmode=disable" -c "ALTER DATABASE litellm OWNER TO litellm_app;" >/dev/null 2>&1 || true
  proxy_down
  echo "-- secrets --"
  : "${OPENAI_API_KEY:?}" ; : "${RESEND_API_KEY:=}"
  sm admin-bootstrap-token "${ADMIN_BOOTSTRAP_TOKEN:-$(openssl rand -hex 24)}"
  sm web-form-signing-key "$(openssl rand -hex 32)"; sm email-signing-key "$(openssl rand -hex 32)"; sm better-auth-secret "$(openssl rand -hex 32)"
  sm litellm-master-key "${LITELLM_MASTER_KEY:-sk-$(openssl rand -hex 20)}"; sm openai-api-key "$OPENAI_API_KEY"; sm resend-api-key "$RESEND_API_KEY"
  sm database-url        "postgresql://app_user:${APP_PW}@/riverbend?host=/cloudsql/${CONN}"
  sm database-admin-url  "postgresql://app_admin:${ADMIN_PW}@/riverbend?host=/cloudsql/${CONN}"
  sm database-migrator-url "postgresql://postgres:${PG_ROOT_PW}@/riverbend?host=/cloudsql/${CONN}"
  sm litellm-database-url "postgresql://litellm_app:${LITELLM_DB_PW}@localhost/litellm?host=/cloudsql/${CONN}&connection_limit=3"
  for s in admin-bootstrap-token database-url database-admin-url database-migrator-url web-form-signing-key email-signing-key better-auth-secret; do grant $s rb-api; done
  for s in database-url database-admin-url database-migrator-url email-signing-key resend-api-key litellm-master-key admin-bootstrap-token; do grant $s rb-worker; done
  for s in openai-api-key litellm-master-key litellm-database-url; do grant $s rb-worker; done
  for sa in rb-api rb-worker; do gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$sa@${PROJECT}.iam.gserviceaccount.com" --role=roles/cloudsql.client >/dev/null 2>&1 || true; done
  echo "-- deploy API --"
  local AU="https://rb-api-PLACEHOLDER"
  gcloud run deploy rb-api --image "$APP_IMG" --region "$REGION" --project "$PROJECT" --service-account "rb-api@${PROJECT}.iam.gserviceaccount.com" \
    --port 8080 --min-instances "$API_MIN" --max-instances 3 --cpu 1 --memory 512Mi --allow-unauthenticated \
    --add-cloudsql-instances "$CONN" \
    --set-secrets DATABASE_URL=database-url:latest,DATABASE_ADMIN_URL=database-admin-url:latest,DATABASE_MIGRATOR_URL=database-migrator-url:latest,ADMIN_BOOTSTRAP_TOKEN=admin-bootstrap-token:latest,WEB_FORM_SIGNING_KEY=web-form-signing-key:latest,EMAIL_SIGNING_KEY=email-signing-key:latest,BETTER_AUTH_SECRET=better-auth-secret:latest \
    --set-env-vars "NODE_ENV=production,AUTO_PROVISION_SHOPS=${AUTO_PROVISION_SHOPS:-true},RESEND_REPLY_DOMAIN=${RESEND_REPLY_DOMAIN:-riverbend.example},RESEND_INBOUND_DOMAIN=${RESEND_INBOUND_DOMAIN:-${RESEND_REPLY_DOMAIN:-riverbend.example}}"
  AU="$(apiurl)"; echo "   API URL: $AU"
  gcloud run services update rb-api --region "$REGION" --project "$PROJECT" --update-env-vars "BETTER_AUTH_URL=$AU,WEB_ALLOWED_ORIGINS=$AU" >/dev/null
  echo "-- deploy worker (+litellm sidecar) --"
  PROJECT="$PROJECT" REGION="$REGION" ENV_SUB_IMG_APP="$APP_IMG" ENV_SUB_IMG_LLM="$LLM_IMG" ENV_SUB_CONN="$CONN" ENV_SUB_WMIN="$WORKER_MIN" RESEND_REPLY_DOMAIN="${RESEND_REPLY_DOMAIN:-riverbend.example}" \
    bash "$ROOT/scripts/gcp/render-worker.sh" >/tmp/rb-worker.gen.yaml
  gcloud run services replace /tmp/rb-worker.gen.yaml --region "$REGION" --project "$PROJECT"
  echo "-- public invoker on API (app-layer auth still enforced) --"
  gcloud run services add-iam-policy-binding rb-api --region "$REGION" --project "$PROJECT" --member=allUsers --role=roles/run.invoker >/dev/null
  echo "-- migrations run at API boot; provisioning shops --"; proxy_up
  ( cd "$ROOT" && DATABASE_ADMIN_URL="postgresql://app_admin:${ADMIN_PW}@127.0.0.1:${PXPORT}/riverbend" RESEND_REPLY_DOMAIN="${RESEND_REPLY_DOMAIN:-riverbend.example}" npx tsx scripts/provision.ts ) || echo "   (provision step reported an issue — re-run: make gcp-deploy, or provision manually)"
  proxy_down
  echo "DONE. Public URL: $AU   Next: make gcp-bootstrap-admin ENV=$ENVNAME"
}

cmd_bootstrap_admin() {
  guard_project
  local AU; AU="$(apiurl)"; [ -n "$AU" ] || die "API not deployed"
  local TOKEN; TOKEN="$(gcloud secrets versions access latest --secret=admin-bootstrap-token --project="$PROJECT" 2>/dev/null)"
  [ -n "$TOKEN" ] || die "no admin-bootstrap-token secret"
  read -r -p "Admin email: " EMAIL
  read -r -s -p "Admin password (min 12 chars, hidden): " PW; echo
  [ "${#PW}" -ge 12 ] || die "password must be >= 12 chars"
  local CODE; CODE="$(curl -s -o /tmp/rb-bootstrap.out -w '%{http_code}' -X POST "$AU/admin/init" -H "x-bootstrap-token: $TOKEN" -H 'content-type: application/json' -d "{\"email\":$(printf '%s' "$EMAIL" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"password\":$(printf '%s' "$PW" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}")"
  unset PW
  case "$CODE" in
    201) echo "admin created (HTTP 201). Log in at $AU/admin/login";;
    409|403) echo "bootstrap already closed (HTTP $CODE) — an admin already exists. Use password reset (see docs).";;
    *) echo "bootstrap failed HTTP $CODE: $(cat /tmp/rb-bootstrap.out)";;
  esac; rm -f /tmp/rb-bootstrap.out
}

cmd_test() {
  guard_project
  local AU; AU="$(apiurl)"; [ -n "$AU" ] || die "API not deployed"
  echo "== gcp-test (public, no auth) against $AU =="
  p() { printf '  %-42s ' "$1"; curl -s -m 15 -o /dev/null -w '%{http_code}\n' "${@:2}"; }
  p "/readyz (public 200)" "$AU/readyz"
  p "/f/rb-downtown form (public 200)" "$AU/f/rb-downtown"
  p "/admin/login page (public 200)" "$AU/admin/login"
  p "/admin/init no-token (401)" -X POST "$AU/admin/init" -H 'content-type: application/json' -d '{}'
  p "/v1/orders no-key (401)" "$AU/v1/orders"
  p "/staff no-session (302/401)" "$AU/staff"
}

cmd_destroy() {
  guard_project
  echo "== gcp-destroy ENV=$ENVNAME project=$PROJECT =="
  echo "This DELETES Cloud Run services, Cloud SQL ($INSTANCE), and secrets in $PROJECT."
  [ "${CONFIRM:-}" = "yes" ] || die "re-run with CONFIRM=yes to proceed"
  for s in rb-api rb-worker rb-litellm; do gcloud run services delete "$s" --region "$REGION" --project "$PROJECT" -q 2>/dev/null || true; done
  gcloud sql instances delete "$INSTANCE" --project "$PROJECT" -q 2>/dev/null || true
  for s in admin-bootstrap-token database-url database-admin-url database-migrator-url web-form-signing-key email-signing-key better-auth-secret litellm-master-key openai-api-key resend-api-key litellm-database-url; do gcloud secrets delete "$s" --project "$PROJECT" -q 2>/dev/null || true; done
  echo "done. (Artifact Registry + service accounts left; delete the project for a full teardown.)"
}

cmd_help() { sed -n '2,14p' "${BASH_SOURCE[0]}"; echo; echo "Subcommands: check | deploy | bootstrap-admin | test | destroy"; }

case "$CMD" in
  check) cmd_check ;;
  deploy) cmd_deploy ;;
  bootstrap-admin) cmd_bootstrap_admin ;;
  test) cmd_test ;;
  destroy) cmd_destroy ;;
  *) cmd_help ;;
esac
