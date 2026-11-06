# Container images (digest-pinned by the CI pipeline before apply).
resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = "riverbend"
  format        = "DOCKER"
  depends_on    = [google_project_service.enabled]
}

# Cloud SQL for PostgreSQL — HA + PITR (D17). The app connects as a non-owner role (RLS forced).
resource "google_sql_database_instance" "pg" {
  name                = "riverbend-pg"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = var.db_deletion_protection
  depends_on          = [google_project_service.enabled]

  settings {
    tier              = var.db_tier
    availability_type = var.db_availability_type # REGIONAL (HA) in prod; ZONAL for staging
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    ip_configuration {
      ipv4_enabled = false # private IP only; reached via the Cloud SQL connector
    }
  }
}

resource "google_sql_database" "riverbend" {
  name     = "riverbend"
  instance = google_sql_database_instance.pg.name
}

# Secret containers only — values are added out-of-band (never in Terraform/state/Git, I7/VII).
locals {
  secret_ids = [
    "admin-bootstrap-token",
    "database-url",
    "database-admin-url",
    "database-migrator-url",
    "web-form-signing-key",
    "email-signing-key",
    "resend-webhook-secret", # D21: Svix signing secret for POST /webhooks/resend (was email-webhook-secret)
    "resend-api-key",        # D21: Resend SDK key — worker outbound + inbound content fetch
    "litellm-master-key",
    "openai-api-key",
  ]
}

resource "google_secret_manager_secret" "app" {
  for_each  = toset(local.secret_ids)
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

# Each runtime SA may read only the secrets it needs (least privilege).
locals {
  api_secrets     = ["admin-bootstrap-token", "database-url", "database-admin-url", "database-migrator-url", "web-form-signing-key", "email-signing-key", "resend-webhook-secret"]
  worker_secrets  = ["database-url", "database-admin-url", "database-migrator-url", "email-signing-key", "resend-api-key", "admin-bootstrap-token", "litellm-master-key"]
  litellm_secrets = ["litellm-master-key", "openai-api-key"]
}

resource "google_secret_manager_secret_iam_member" "api" {
  for_each  = toset(local.api_secrets)
  secret_id = google_secret_manager_secret.app[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "worker" {
  for_each  = toset(local.worker_secrets)
  secret_id = google_secret_manager_secret.app[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_secret_manager_secret_iam_member" "litellm" {
  for_each  = toset(local.litellm_secrets)
  secret_id = google_secret_manager_secret.app[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.litellm.email}"
}

# Cloud SQL client role for the api + worker runtimes.
resource "google_project_iam_member" "api_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "worker_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.worker.email}"
}
