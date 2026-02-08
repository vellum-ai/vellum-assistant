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

# Database settings
variable "db_user" {
  description = "AlloyDB database user"
  type        = string
  default     = "vellum"
}

variable "db_name" {
  description = "AlloyDB database name"
  type        = string
  default     = "vellum_assistant"
}

variable "db_cpu_count" {
  description = "Number of CPUs for AlloyDB instance"
  type        = number
  default     = 2
}

variable "anthropic_api_key" {
  description = "Anthropic API key"
  type        = string
  sensitive   = true
}
