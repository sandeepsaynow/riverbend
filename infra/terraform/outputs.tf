output "load_balancer_ip" {
  description = "Point the DNS A record for var.domain at this address."
  value       = google_compute_global_address.api.address
}

output "api_url" {
  description = "Direct Cloud Run URL of the api (internal; prefer the LB)."
  value       = google_cloud_run_v2_service.api.uri
}

output "sql_connection_name" {
  value = google_sql_database_instance.pg.connection_name
}

output "workload_identity_provider" {
  description = "Set as the google-github-actions/auth workload_identity_provider input in CI."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account" {
  value = google_service_account.deployer.email
}
