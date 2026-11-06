# Cloud Run v2 services (D17). api is reachable only via the external LB; worker + litellm are
# internal-only. Each runs as its own least-privilege SA and reads config from Secret Manager.
locals {
  db_env = ["database-url", "database-admin-url", "database-migrator-url"]
}

resource "google_cloud_run_v2_service" "api" {
  name     = "rb-api"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account = google_service_account.api.email
    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.pg.connection_name]
      }
    }
    containers {
      image = var.image_api
      ports {
        container_port = 8080
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      dynamic "env" {
        for_each = toset(["admin-bootstrap-token", "web-form-signing-key", "email-signing-key", "resend-webhook-secret"])
        content {
          name = replace(upper(env.value), "-", "_")
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = toset(local.db_env)
        content {
          name = replace(upper(env.value), "-", "_")
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_cloud_run_v2_service" "worker" {
  name     = "rb-worker"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.worker.email
    scaling {
      min_instance_count = var.worker_min_instances
      max_instance_count = var.worker_min_instances # fixed count: queue-depth autoscaling is a known gap
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.pg.connection_name]
      }
    }
    containers {
      image   = var.image_worker
      command = ["npm", "run", "start:worker"]
      # The worker is a background queue consumer, but Cloud Run runs it as a *service*, so it must accept
      # the startup/liveness probe on the port. The worker binds a minimal health listener on $PORT (D25);
      # 8080 matches Cloud Run's injected PORT. Without this the revision never turns healthy.
      ports {
        container_port = 8080
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        failure_threshold     = 6
      }
      liveness_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds = 30
      }
      resources {
        cpu_idle = false # always-allocated CPU: the worker polls the queue between requests
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "LLM_BASE_URL"
        value = "${google_cloud_run_v2_service.litellm.uri}/v1"
      }
      # Verified against a live staging deploy (D27): without LLM_MODEL the worker silently falls back to the
      # FakeGateway (config needs BOTH LLM_BASE_URL and LLM_MODEL to use the real provider). The alias resolves
      # at the proxy to the backing snapshot (D26).
      env {
        name  = "LLM_MODEL"
        value = "riverbend-extraction"
      }
      # Email (006/D21): the verified sender + Resend receiving domain (non-secret config). Set these to
      # the verified domain before going live; outbound is restricted until a sending domain is verified.
      env {
        name  = "RESEND_FROM"
        value = var.resend_from
      }
      env {
        name  = "RESEND_REPLY_DOMAIN"
        value = var.resend_reply_domain
      }
      # D27: the proxy key (LLM_API_KEY) authenticates to LiteLLM; the master key (LLM_MASTER_KEY) provisions
      # the per-shop team + virtual key under BUDGET_AUTHORITY=litellm. Both are the LiteLLM master key (NOT the
      # backing-provider key). Omitting them breaks real extraction and per-shop budget enforcement.
      env {
        name = "LLM_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["litellm-master-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "LLM_MASTER_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["litellm-master-key"].secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        # DB urls + email secrets + ADMIN_BOOTSTRAP_TOKEN. D27: the shared config schema REQUIRES
        # ADMIN_BOOTSTRAP_TOKEN, so without it the worker crashes on boot ("Invalid configuration — refusing
        # to start"), confirmed on a live staging revision. The worker never uses it, but config validation does.
        for_each = toset(concat(local.db_env, ["email-signing-key", "resend-api-key", "admin-bootstrap-token"]))
        content {
          name = replace(upper(env.value), "-", "_")
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_project_service.enabled]
}

# Internal-only LiteLLM proxy — the single holder of the provider key (D6). Reached by the worker
# on the internal network; never exposed to the LB.
#
# D27 (verified on live staging): for BUDGET_AUTHORITY=litellm the proxy MUST have its own database, or it
# logs "budget will NOT be enforced" and per-shop team/virtual-key provisioning fails (the whole extraction
# path then errors). This resource below is missing a DATABASE_URL + a litellm database/role. Two supported
# shapes: (a) add a `litellm` Cloud SQL database + a `litellm-database-url` secret (Prisma needs the
# `@localhost/db?host=/cloudsql/<conn>` socket form, NOT the empty-host form the app uses), mount the cloudsql
# volume here, and inject DATABASE_URL; or (b) run LiteLLM as a SIDECAR in the worker service (worker →
# localhost:4000), which the staging deploy used — it removes the cross-service IAM/auth conflict entirely
# (the LiteLLM virtual key lives in Authorization, which collides with Cloud Run IAM tokens). See
# docs/gcp-deployment.md §"Staging deployment (verified)".
resource "google_cloud_run_v2_service" "litellm" {
  name     = "rb-litellm"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.litellm.email
    scaling {
      min_instance_count = var.litellm_min_instances
      max_instance_count = var.litellm_max_instances
    }
    containers {
      # NOTE: var.litellm_image MUST be the custom image built from infra/litellm/Dockerfile, which bakes
      # litellm/config.yaml (the riverbend-extraction alias → gpt-5.4-mini + per-shop budgets) and sets the
      # --config CMD. The stock berriai/litellm image has no model_list, so the alias would not resolve and
      # all extraction calls would fail. See docs/gcp-deployment.md §LiteLLM image.
      image = var.litellm_image
      ports {
        container_port = 4000
      }
      env {
        name = "OPENAI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["openai-api-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "LITELLM_MASTER_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["litellm-master-key"].secret_id
            version = "latest"
          }
        }
      }
    }
  }
  depends_on = [google_project_service.enabled]
}
