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
      min_instance_count = 1
      max_instance_count = 10
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
      dynamic "env" {
        # DB urls + email secrets (EMAIL_SIGNING_KEY for reply correlation, RESEND_API_KEY for send/fetch).
        for_each = toset(concat(local.db_env, ["email-signing-key", "resend-api-key"]))
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
resource "google_cloud_run_v2_service" "litellm" {
  name     = "rb-litellm"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.litellm.email
    scaling {
      min_instance_count = 1
      max_instance_count = 3
    }
    containers {
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
