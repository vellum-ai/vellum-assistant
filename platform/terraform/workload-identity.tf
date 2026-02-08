# Workload Identity Federation IAM bindings
# Note: The Workload Identity Pool, Provider, and Service Account
# were created manually to avoid circular dependencies.

# Service Account: github-actions@vellum-ai-prod.iam.gserviceaccount.com
# Provider: projects/620844561845/locations/global/workloadIdentityPools/github-actions/providers/github-provider

# Grant necessary permissions to the existing service account
resource "google_project_iam_member" "github_actions_container_developer" {
  project = var.project_id
  role    = "roles/container.developer"
  member  = "serviceAccount:github-actions@vellum-ai-prod.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "github_actions_storage_admin" {
  project = var.project_id
  role    = "roles/storage.admin"
  member  = "serviceAccount:github-actions@vellum-ai-prod.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "github_actions_compute_viewer" {
  project = var.project_id
  role    = "roles/compute.viewer"
  member  = "serviceAccount:github-actions@vellum-ai-prod.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "github_actions_iam_workload_identity_user" {
  project = var.project_id
  role    = "roles/iam.workloadIdentityUser"
  member  = "serviceAccount:github-actions@vellum-ai-prod.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "github_actions_service_account_token_creator" {
  project = var.project_id
  role    = "roles/iam.serviceAccountTokenCreator"
  member  = "serviceAccount:github-actions@vellum-ai-prod.iam.gserviceaccount.com"
}
