terraform {
  required_version = ">= 1.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.25"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "gcs" {
    bucket = "vellum-ai-prod-terraform-state"
    prefix = "production"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# GKE Cluster
resource "google_container_cluster" "main" {
  name     = var.cluster_name
  location = var.region

  depends_on = [google_project_service.container, google_project_service.compute]

  # We can't create a cluster with no node pool, but we want to use
  # separately managed node pools. So we create the smallest possible
  # default pool and immediately delete it.
  remove_default_node_pool = true
  initial_node_count       = 1

  # Enable Workload Identity
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  # Network config
  network    = var.network
  subnetwork = var.subnetwork

  # Enable network policy
  network_policy {
    enabled = true
  }

  # Private cluster config
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }

  # Master authorized networks
  master_authorized_networks_config {
    cidr_blocks {
      cidr_block   = "0.0.0.0/0"
      display_name = "All"
    }
  }
}

# Node Pool
resource "google_container_node_pool" "primary" {
  name       = "primary-pool"
  location   = var.region
  cluster    = google_container_cluster.main.name
  node_count = var.node_count

  node_config {
    machine_type = var.machine_type
    disk_size_gb = 50
    disk_type    = "pd-standard"

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform"
    ]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    labels = {
      env = var.environment
    }

    tags = ["gke-node", var.cluster_name]
  }

  autoscaling {
    min_node_count = 1
    max_node_count = var.max_node_count
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

data "google_client_config" "default" {}

provider "kubernetes" {
  host                   = "https://${google_container_cluster.main.endpoint}"
  token                  = data.google_client_config.default.access_token
  cluster_ca_certificate = base64decode(google_container_cluster.main.master_auth[0].cluster_ca_certificate)
}

# Static IP for Ingress
resource "google_compute_global_address" "ingress_ip" {
  name = "vellum-assistant-ip"

  depends_on = [google_project_service.compute]
}

# Managed SSL Certificate
resource "google_compute_managed_ssl_certificate" "default" {
  name = "vellum-assistant-cert"

  depends_on = [google_project_service.compute]

  managed {
    domains = [var.domain]
  }
}
