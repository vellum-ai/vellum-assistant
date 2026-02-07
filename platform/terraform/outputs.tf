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
