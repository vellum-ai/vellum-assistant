# Platform Infrastructure

Terraform configuration for deploying Vellum Assistant to GKE.

## Architecture

```
                    ┌─────────────────┐
                    │  assistant.     │
                    │  vellum.ai      │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Cloud Load     │
                    │  Balancer       │
                    │  (Static IP)    │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  GKE Ingress    │
                    │  (SSL/TLS)      │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
        │  Pod 1    │  │  Pod 2    │  │  Pod N    │
        │  Next.js  │  │  Next.js  │  │  Next.js  │
        └───────────┘  └───────────┘  └───────────┘
```

## Prerequisites

1. GCP project with billing enabled
2. `gcloud` CLI authenticated
3. Terraform >= 1.0
4. Existing GKE cluster (or set `create_cluster = true`)

## Quick Start

```bash
cd terraform

# Copy and edit variables
cp terraform.tfvars.example terraform.tfvars

# Set sensitive variables via environment
export TF_VAR_database_url="postgresql://..."
export TF_VAR_anthropic_api_key="sk-ant-..."

# Initialize Terraform
terraform init

# Plan changes
terraform plan

# Apply
terraform apply
```

## DNS Setup

After applying, Terraform outputs the static IP. Create an A record:

```
assistant.vellum.ai -> <ingress_ip from output>
```

The managed SSL certificate will auto-provision once DNS propagates.

## Building the Docker Image

```bash
cd ../web

# Build
docker build -t gcr.io/PROJECT_ID/vellum-assistant:latest .

# Push
docker push gcr.io/PROJECT_ID/vellum-assistant:latest
```

## Files

- `main.tf` - GCP provider, GKE cluster, static IP, SSL cert
- `k8s.tf` - Kubernetes deployment, service, ingress
- `variables.tf` - Input variables
- `outputs.tf` - Useful outputs
- `terraform.tfvars.example` - Example configuration

## Using Existing Cluster

If you have an existing GKE cluster:

```hcl
create_cluster = false
cluster_name   = "your-existing-cluster"
```

The Terraform will deploy the app to the existing cluster.

## Creating New Cluster

```hcl
create_cluster = true
cluster_name   = "vellum-assistant"
```

This creates a private GKE cluster with:
- Workload Identity enabled
- Autoscaling node pool (1-3 nodes)
- Network policy enabled
