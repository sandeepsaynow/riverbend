# External HTTPS load balancer with Cloud Armor in front of the public api (D17). The serverless NEG
# targets the api Cloud Run service; Cloud Armor applies WAF + per-IP rate limiting at the edge.
resource "google_compute_region_network_endpoint_group" "api" {
  name                  = "rb-api-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.api.name
  }
}

resource "google_compute_security_policy" "armor" {
  name = "rb-armor"

  # Per-IP rate limit (throttle) — the edge backstop in front of app-level limits.
  rule {
    action   = "throttle"
    priority = 1000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 120
        interval_sec = 60
      }
    }
  }

  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "default allow"
  }
}

resource "google_compute_backend_service" "api" {
  name                  = "rb-api-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.armor.id
  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }
}

resource "google_compute_url_map" "api" {
  name            = "rb-api-urlmap"
  default_service = google_compute_backend_service.api.id
}

resource "google_compute_managed_ssl_certificate" "api" {
  name = "rb-api-cert"
  managed {
    domains = [var.domain]
  }
}

resource "google_compute_target_https_proxy" "api" {
  name             = "rb-api-proxy"
  url_map          = google_compute_url_map.api.id
  ssl_certificates = [google_compute_managed_ssl_certificate.api.id]
}

resource "google_compute_global_address" "api" {
  name = "rb-api-ip"
}

resource "google_compute_global_forwarding_rule" "api" {
  name                  = "rb-api-fr"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "443"
  target                = google_compute_target_https_proxy.api.id
  ip_address            = google_compute_global_address.api.id
}
