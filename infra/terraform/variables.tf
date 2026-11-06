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

# Cost/HA knobs (prod-safe defaults; a staging tfvars lowers these). Keeping prod defaults here means an
# existing prod plan is byte-for-byte unchanged, while staging can run small, zonal, and deletable.
variable "db_availability_type" {
  type        = string
  description = "Cloud SQL availability: REGIONAL (HA, prod) or ZONAL (single-zone, cheaper staging)."
  default     = "REGIONAL"
}

variable "db_deletion_protection" {
  type        = bool
  description = "Block `terraform destroy` from deleting the SQL instance. true in prod; false for disposable staging."
  default     = true
}

variable "api_min_instances" {
  type        = number
  description = "api Cloud Run minimum instances. 1 keeps it warm (prod); 0 scales to zero (cheap staging)."
  default     = 1
}

variable "api_max_instances" {
  type        = number
  description = "api Cloud Run maximum instances."
  default     = 10
}

variable "litellm_min_instances" {
  type        = number
  description = "litellm proxy minimum instances. 1 avoids cold starts (prod); 0 scales to zero (staging)."
  default     = 1
}

variable "litellm_max_instances" {
  type        = number
  description = "litellm proxy maximum instances."
  default     = 3
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

variable "resend_from" {
  type        = string
  description = "Verified Resend sender, e.g. \"Riverbend Cycles <no-reply@mail.riverbend.example>\" (D21). Outbound is restricted until a sending domain is verified; use onboarding@resend.dev while testing."
  default     = "Riverbend Cycles <onboarding@resend.dev>"
}

variable "resend_reply_domain" {
  type        = string
  description = "Resend receiving domain for reply+<token>@ correlation addresses (D21), e.g. a verified inbound subdomain or the account's managed <id>.resend.app."
  default     = "riverbend.example"
}
