output "cluster_name" {
  description = "GKE cluster name"
  value       = var.create_cluster ? google_container_cluster.main[0].name : var.cluster_name
}

output "cluster_endpoint" {
  description = "GKE cluster endpoint"
  value       = data.google_container_cluster.main.endpoint
  sensitive   = true
}

output "ingress_ip" {
  description = "Static IP address for the ingress"
  value       = google_compute_global_address.ingress_ip.address
}

output "domain" {
  description = "Application domain"
  value       = var.domain
}

output "dns_record" {
  description = "DNS A record to create"
  value       = "Create an A record: ${var.domain} -> ${google_compute_global_address.ingress_ip.address}"
}

output "namespace" {
  description = "Kubernetes namespace"
  value       = kubernetes_namespace.vellum_assistant.metadata[0].name
}

# Database outputs
output "alloydb_cluster_id" {
  description = "AlloyDB cluster ID"
  value       = google_alloydb_cluster.main.cluster_id
}

output "alloydb_instance_ip" {
  description = "AlloyDB instance IP address"
  value       = google_alloydb_instance.primary.ip_address
  sensitive   = true
}

output "database_secret_id" {
  description = "Secret Manager secret ID for DATABASE_URL"
  value       = google_secret_manager_secret.database_url.secret_id
}

output "editor_templates_bucket" {
  description = "GCS bucket for editor templates"
  value       = google_storage_bucket.editor_templates.name
}

output "database_connection_info" {
  description = "Database connection information"
  value       = <<-EOT
    AlloyDB cluster: ${google_alloydb_cluster.main.name}
    Database: ${local.db_name}
    User: ${local.db_user}
    Secret: ${google_secret_manager_secret.database_url.name}
    
    To retrieve the DATABASE_URL from Secret Manager:
    gcloud secrets versions access latest --secret="${google_secret_manager_secret.database_url.secret_id}" --project="${var.project_id}"
  EOT
}
