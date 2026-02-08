resource "google_storage_bucket" "editor_templates" {
  name     = "${var.project_id}-editor-templates"
  location = var.region
  project  = var.project_id

  depends_on = [google_project_service.storage]

  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  labels = {
    environment = var.environment
    app         = "vellum-assistant"
  }
}

resource "google_storage_bucket_iam_member" "editor_templates_gke_reader" {
  bucket     = google_storage_bucket.editor_templates.name
  role       = "roles/storage.objectViewer"
  member     = "serviceAccount:${var.project_id}.svc.id.goog[vellum-assistant/default]"
  depends_on = [google_container_cluster.main]
}

resource "google_storage_bucket_iam_member" "editor_templates_gke_writer" {
  bucket     = google_storage_bucket.editor_templates.name
  role       = "roles/storage.objectAdmin"
  member     = "serviceAccount:${var.project_id}.svc.id.goog[vellum-assistant/default]"
  depends_on = [google_container_cluster.main]
}

resource "google_storage_bucket" "vellum_assistant" {
  name     = "${var.project_id}-vellum-assistant"
  location = var.region
  project  = var.project_id

  depends_on = [google_project_service.storage]

  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  labels = {
    environment = var.environment
    app         = "vellum-assistant"
  }
}

resource "google_storage_bucket_iam_member" "vellum_assistant_gke_reader" {
  bucket     = google_storage_bucket.vellum_assistant.name
  role       = "roles/storage.objectViewer"
  member     = "serviceAccount:${var.project_id}.svc.id.goog[vellum-assistant/default]"
  depends_on = [google_container_cluster.main]
}

resource "google_storage_bucket_iam_member" "vellum_assistant_gke_writer" {
  bucket     = google_storage_bucket.vellum_assistant.name
  role       = "roles/storage.objectAdmin"
  member     = "serviceAccount:${var.project_id}.svc.id.goog[vellum-assistant/default]"
  depends_on = [google_container_cluster.main]
}

resource "google_service_account" "dev_sa" {
  account_id   = "dev-sa"
  display_name = "Vellum Assistant Dev Service Account"
  project      = var.project_id
}

resource "google_project_iam_member" "dev_sa_compute_admin" {
  project = var.project_id
  role    = "roles/compute.admin"
  member  = "serviceAccount:${google_service_account.dev_sa.email}"
}

resource "google_project_iam_member" "dev_sa_service_account_user" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.dev_sa.email}"
}

resource "google_storage_bucket_iam_member" "dev_sa_assistant_bucket" {
  bucket = google_storage_bucket.vellum_assistant.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.dev_sa.email}"
}

resource "google_storage_bucket_iam_member" "dev_sa_editor_templates_bucket" {
  bucket = google_storage_bucket.editor_templates.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.dev_sa.email}"
}
