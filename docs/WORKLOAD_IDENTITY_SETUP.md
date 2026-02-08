# GitHub Workload Identity Federation Setup

This document explains how to set up GitHub Workload Identity Federation for GCP authentication, replacing the need for service account keys.

## Prerequisites

- GCP Project with appropriate permissions
- GitHub repository with Actions enabled
- `gcloud` CLI installed and authenticated

## Setup Steps

### 1. Create a Workload Identity Pool

```bash
# Set your project ID
PROJECT_ID="your-project-id"
gcloud config set project $PROJECT_ID

# Create the workload identity pool
gcloud iam workload-identity-pools create "github-actions" \
  --location="global" \
  --description="Pool for GitHub Actions" \
  --display-name="GitHub Actions Pool"

# Get the full pool name (you'll need this later)
gcloud iam workload-identity-pools describe "github-actions" \
  --location="global" \
  --format="value(name)"
```

### 2. Create a Workload Identity Provider

```bash
# Get your GitHub org/repo (e.g., vellum-ai/vellum-assistant)
GITHUB_REPO="your-org/your-repo"

# Create the provider
gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --location="global" \
  --workload-identity-pool="github-actions" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository_owner == '${GITHUB_REPO%%/*}'"
```

### 3. Configure Service Account Permissions

```bash
# Your existing service account email
SERVICE_ACCOUNT="your-service-account@your-project.iam.gserviceaccount.com"

# Get the full pool + provider name
WORKLOAD_IDENTITY_PROVIDER="projects/$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')/locations/global/workloadIdentityPools/github-actions/providers/github-provider"

# Grant the service account permission to be impersonated by GitHub Actions
gcloud iam service-accounts add-iam-policy-binding $SERVICE_ACCOUNT \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${WORKLOAD_IDENTITY_PROVIDER%%/providers/*}/attribute.repository/${GITHUB_REPO}"
```

### 4. Set GitHub Repository Variables

In your GitHub repository, go to Settings → Secrets and variables → Actions → Variables, and add:

1. **GCP_WORKLOAD_IDENTITY_PROVIDER**
   - Value: The full workload identity provider path from step 3
   - Format: `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/providers/github-provider`

2. **GCP_SERVICE_ACCOUNT**
   - Value: Your service account email
   - Format: `your-service-account@your-project.iam.gserviceaccount.com`

### 5. Verify Setup

After setting up, the GitHub Actions workflows will authenticate using OIDC tokens instead of service account keys. The workflows have been updated to use:

```yaml
- name: Authenticate to Google Cloud
  uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}
    service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}
```

## Benefits

- **No more secrets**: No need to store and rotate service account keys
- **Better security**: Short-lived tokens with fine-grained access control
- **Audit trail**: All authentication attempts are logged in GCP
- **Automatic rotation**: Tokens are automatically rotated by GitHub and GCP

## Cleanup (Optional)

After successfully migrating to Workload Identity Federation, you can:

1. Delete the `GCP_SA_KEY` secret from GitHub
2. Delete or rotate any existing service account keys in GCP (if they're no longer needed)

## Troubleshooting

If authentication fails:

1. Verify the workload identity provider path is correct
2. Check that the service account has the necessary permissions
3. Ensure the GitHub repository matches the attribute condition
4. Review the GitHub Actions logs for detailed error messages
5. Check GCP IAM audit logs for authentication attempts

## References

- [GitHub Actions OIDC](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [GCP Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation)
- [google-github-actions/auth](https://github.com/google-github-actions/auth)
