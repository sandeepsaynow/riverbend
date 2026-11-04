# Enabled APIs (D17). Kept explicit so the project is reproducible from zero.
locals {
  services = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "aiplatform.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

# One least-privilege runtime identity per process (api, worker, internal LiteLLM proxy).
resource "google_service_account" "api" {
  account_id   = "rb-api"
  display_name = "Riverbend api runtime"
}

resource "google_service_account" "worker" {
  account_id   = "rb-worker"
  display_name = "Riverbend worker runtime"
}

resource "google_service_account" "litellm" {
  account_id   = "rb-litellm"
  display_name = "Riverbend LiteLLM proxy runtime"
}

# Deploy identity assumed by GitHub Actions via Workload Identity Federation — no long-lived JSON keys.
resource "google_service_account" "deployer" {
  account_id   = "rb-deployer"
  display_name = "Riverbend CI deployer (WIF)"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "rb-github-pool"
  display_name              = "Riverbend GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "rb-github-provider"
  display_name                       = "GitHub OIDC"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  # Only our repository may mint tokens for the deployer.
  attribute_condition = "assertion.repository == \"${var.github_repo}\""
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}
