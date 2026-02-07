variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "prod"
}

# Cluster settings
variable "create_cluster" {
  description = "Whether to create a new GKE cluster or use existing"
  type        = bool
  default     = false
}

variable "cluster_name" {
  description = "GKE cluster name"
  type        = string
  default     = "vellum-assistant"
}

variable "network" {
  description = "VPC network name"
  type        = string
  default     = "default"
}

variable "subnetwork" {
  description = "VPC subnetwork name"
  type        = string
  default     = "default"
}

variable "machine_type" {
  description = "Node machine type"
  type        = string
  default     = "e2-medium"
}

variable "node_count" {
  description = "Initial number of nodes per zone"
  type        = number
  default     = 1
}

variable "max_node_count" {
  description = "Maximum number of nodes per zone for autoscaling"
  type        = number
  default     = 3
}

# Application settings
variable "domain" {
  description = "Domain for the application"
  type        = string
  default     = "assistant.vellum.ai"
}

variable "app_image" {
  description = "Docker image for the Next.js app"
  type        = string
  default     = "gcr.io/PROJECT_ID/vellum-assistant:latest"
}

variable "app_replicas" {
  description = "Number of app replicas"
  type        = number
  default     = 2
}

variable "database_url" {
  description = "PostgreSQL connection string"
  type        = string
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key"
  type        = string
  sensitive   = true
}
