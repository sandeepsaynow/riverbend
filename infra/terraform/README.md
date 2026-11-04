# Riverbend — GCP infrastructure (Terraform)

Infrastructure-as-code for the deployment target (D17). **No live deploy is performed** — the brief
allows IaC + `plan` to score the same. CI runs `fmt`/`validate`/`plan`; `apply` is gated on a real
GCP project (blocker **B2**).

## Stack
- **Cloud Run v2**: `rb-api` (public, behind the LB only), `rb-worker` (internal, always-on CPU, fixed
  count), `rb-litellm` (internal-only proxy, holds the provider key).
- **Cloud SQL for PostgreSQL 16**: regional HA + PITR, private IP, reached via the Cloud SQL connector.
- **Secret Manager**: empty secret containers (values added out-of-band — never in TF/state/Git, I7).
  Each runtime SA reads only the secrets it needs.
- **External HTTPS LB + Cloud Armor**: serverless NEG → backend → managed cert; Armor adds per-IP rate
  limiting at the edge.
- **Workload Identity Federation**: GitHub Actions deploys with short-lived tokens — no JSON keys.

## Verify locally (no credentials needed)
```sh
cd infra/terraform
terraform init -backend=false
terraform fmt -check -recursive
terraform validate          # ✔ validated with Terraform v1.17.1 / google provider ~> 6.0
```
`terraform plan`/`apply` need `project_id` + application-default credentials (B2). Copy
`terraform.tfvars.example` → `terraform.tfvars` first.

## Known deploy-time caveats (also in the root README "what breaks first")
- Cloud Run worker **does not autoscale on queue depth** — it is a fixed count here; at scale add a
  depth-based autoscaler (e.g. a Pub/Sub or CRON-driven scaler), or move the worker to a GKE/MIG pool.
- Cloud SQL connection budget: pods × `connection_limit` must stay under `max_connections`; verify RLS
  `set_config` + pg-boss behave through any managed connection pooler before relying on it.
