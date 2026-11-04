variable "project_id" {
  type        = string
  description = "GCP project id."
}

variable "region" {
  type        = string
  description = "Primary region for Cloud Run + Cloud SQL."
  default     = "us-central1"
}

variable "image_api" {
  type        = string
  description = "Fully-qualified container image for the api process (Artifact Registry, digest-pinned)."
}

variable "image_worker" {
  type        = string
  description = "Container image for the worker process."
}

variable "litellm_image" {
  type        = string
  description = "Digest-pinned LiteLLM proxy image (internal-only)."
}

variable "db_tier" {
  type        = string
  description = "Cloud SQL machine tier."
  default     = "db-custom-2-7680"
}

variable "github_repo" {
  type        = string
  description = "owner/repo allowed to deploy via Workload Identity Federation (no long-lived keys)."
}

variable "worker_min_instances" {
  type        = number
  description = "Fixed worker instance count (worker pools do not autoscale on queue depth — see README)."
  default     = 1
}

variable "domain" {
  type        = string
  description = "Public hostname for the external HTTPS load balancer's managed certificate."
}
