#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOYMENT_MANIFEST="$ROOT_DIR/deploy/k8s/deployment.staging.yaml"
SERVICE_MANIFEST="$ROOT_DIR/deploy/k8s/service.staging.yaml"

if ! command -v rg >/dev/null 2>&1; then
  echo "rg is required for managed-gateway staging smoke checks" >&2
  exit 1
fi

if [[ ! -f "$DEPLOYMENT_MANIFEST" ]]; then
  echo "Missing deployment manifest: $DEPLOYMENT_MANIFEST" >&2
  exit 1
fi

if [[ ! -f "$SERVICE_MANIFEST" ]]; then
  echo "Missing service manifest: $SERVICE_MANIFEST" >&2
  exit 1
fi

rg -q "kind: Deployment" "$DEPLOYMENT_MANIFEST"
rg -q "name: managed-gateway" "$DEPLOYMENT_MANIFEST"
rg -q "containerPort: 7831" "$DEPLOYMENT_MANIFEST"
rg -q "MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL" "$DEPLOYMENT_MANIFEST"
rg -q "path: /v1/internal/managed-gateway/readyz/" "$DEPLOYMENT_MANIFEST"
rg -q "path: /v1/internal/managed-gateway/healthz/" "$DEPLOYMENT_MANIFEST"

rg -q "kind: Service" "$SERVICE_MANIFEST"
rg -q "targetPort: http" "$SERVICE_MANIFEST"

if [[ -n "${MANAGED_GATEWAY_STAGING_BASE_URL:-}" ]]; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required for live endpoint probes" >&2
    exit 1
  fi

  base_url="${MANAGED_GATEWAY_STAGING_BASE_URL%/}"
  curl -fsS "$base_url/v1/internal/managed-gateway/healthz/" >/dev/null
  curl -fsS "$base_url/v1/internal/managed-gateway/readyz/" >/dev/null
  echo "Managed-gateway live readiness probes passed at $base_url"
else
  echo "MANAGED_GATEWAY_STAGING_BASE_URL is not set; skipping live endpoint probes."
fi

echo "Managed-gateway staging manifest smoke checks passed."
