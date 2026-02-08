# AlloyDB Cluster and Instance Configuration

locals {
  # Hardcoded database configuration
  db_user      = "vellum"
  db_name      = "vellum"
  db_cpu_count = 2

  # Generate random password for the database
  db_password = random_password.db_password.result

  # Construct the DATABASE_URL in PostgreSQL format with URL-encoded password
  database_url = "postgresql://${local.db_user}:${urlencode(local.db_password)}@${google_alloydb_instance.primary.ip_address}:5432/${local.db_name}?sslmode=require"
}

# Random password for the database
resource "random_password" "db_password" {
  length  = 32
  special = true
}

# AlloyDB Cluster
resource "google_alloydb_cluster" "main" {
  cluster_id = "${var.cluster_name}-db"
  location   = var.region
  network_config {
    network = "projects/${var.project_id}/global/networks/${var.network}"
  }

  initial_user {
    user     = local.db_user
    password = random_password.db_password.result
  }

  labels = {
    environment = var.environment
  }
}

# AlloyDB Primary Instance
resource "google_alloydb_instance" "primary" {
  cluster       = google_alloydb_cluster.main.name
  instance_id   = "${var.cluster_name}-db-primary"
  instance_type = "PRIMARY"

  machine_config {
    cpu_count = local.db_cpu_count
  }

  depends_on = [google_alloydb_cluster.main]
}

# Store DATABASE_URL in Secret Manager
resource "google_secret_manager_secret" "database_url" {
  secret_id = "database-url"

  replication {
    auto {}
  }

  labels = {
    environment = var.environment
  }
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = local.database_url
}

# Grant the GKE workload identity service account access to read the secret
resource "google_secret_manager_secret_iam_member" "gke_workload_secret_accessor" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.project_id}.svc.id.goog[vellum-assistant/default]"
}
