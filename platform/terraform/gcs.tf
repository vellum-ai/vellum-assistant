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
