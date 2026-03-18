#!/usr/bin/env bash
#
# dockerhub-publish.sh — Manually build and push Docker images to Docker Hub.
#
# Builds multi-arch (linux/amd64, linux/arm64) images for the assistant,
# gateway, and credential-executor services, then pushes them to Docker Hub
# under the vellumai/ namespace.
#
# Prerequisites:
#   - Docker with buildx support (Docker Desktop or buildx plugin)
#   - QEMU registered for multi-arch builds (the script sets this up)
#   - Authenticated to Docker Hub: `docker login`
#
# Usage:
#   ./scripts/dockerhub-publish.sh --version <semver>
#   ./scripts/dockerhub-publish.sh --version <semver> --services assistant,gateway
#   ./scripts/dockerhub-publish.sh --version <semver> --skip-latest
#
# Options:
#   --version <semver>    Version to tag images with (required). Used as v<semver> tag.
#                         Example: --version 1.2.3  →  tags as v1.2.3
#   --services <list>     Comma-separated list of services to publish (default: all).
#                         Valid values: assistant, gateway, credential-executor
#   --skip-latest         Do not tag images with :latest
#   --dry-run             Build images but do not push to Docker Hub

set -euo pipefail

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------

VERSION=""
SERVICES=""
SKIP_LATEST=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --version requires a value"
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    --services)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --services requires a comma-separated list"
        exit 1
      fi
      SERVICES="$2"
      shift 2
      ;;
    --skip-latest)
      SKIP_LATEST=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 --version <semver> [--services assistant,gateway,credential-executor] [--skip-latest] [--dry-run]"
      exit 1
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "ERROR: --version is required"
  echo "Usage: $0 --version <semver> [--services assistant,gateway,credential-executor] [--skip-latest] [--dry-run]"
  exit 1
fi

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DOCKERHUB_ORG="vellumai"
PLATFORMS="linux/amd64,linux/arm64"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Image name mapping: service → Docker Hub image name
declare -A IMAGE_NAMES=(
  [assistant]="vellum-assistant"
  [gateway]="vellum-gateway"
  [credential-executor]="vellum-credential-executor"
)

# Build context mapping: service → build context (relative to repo root)
declare -A BUILD_CONTEXTS=(
  [assistant]="."
  [gateway]="gateway"
  [credential-executor]="."
)

# Dockerfile mapping: service → Dockerfile path (relative to repo root)
declare -A DOCKERFILES=(
  [assistant]="assistant/Dockerfile"
  [gateway]="gateway/Dockerfile"
  [credential-executor]="credential-executor/Dockerfile"
)

ALL_SERVICES=("assistant" "gateway" "credential-executor")

# Resolve which services to build
if [[ -n "$SERVICES" ]]; then
  IFS=',' read -ra SELECTED_SERVICES <<< "$SERVICES"
  for svc in "${SELECTED_SERVICES[@]}"; do
    if [[ -z "${IMAGE_NAMES[$svc]+x}" ]]; then
      echo "ERROR: Unknown service '$svc'. Valid services: ${ALL_SERVICES[*]}"
      exit 1
    fi
  done
else
  SELECTED_SERVICES=("${ALL_SERVICES[@]}")
fi

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

echo "==> Pre-flight checks"

if ! command -v docker &>/dev/null; then
  echo "ERROR: docker is not installed or not in PATH"
  exit 1
fi

if ! docker buildx version &>/dev/null; then
  echo "ERROR: docker buildx is not available. Install the buildx plugin."
  exit 1
fi

# Verify Docker Hub authentication
if ! docker info 2>/dev/null | grep -q "Username"; then
  echo "WARNING: You may not be logged into Docker Hub."
  echo "  Run: docker login"
  echo "  Continuing anyway — the push step will fail if not authenticated."
fi

echo "  Version:    v${VERSION}"
echo "  Services:   ${SELECTED_SERVICES[*]}"
echo "  Platforms:  ${PLATFORMS}"
echo "  Skip latest: ${SKIP_LATEST}"
echo "  Dry run:    ${DRY_RUN}"
echo ""

# ---------------------------------------------------------------------------
# Set up buildx builder with multi-arch support
# ---------------------------------------------------------------------------

echo "==> Setting up Docker Buildx"

BUILDER_NAME="vellum-multiarch"
if ! docker buildx inspect "$BUILDER_NAME" &>/dev/null; then
  echo "  Creating buildx builder: ${BUILDER_NAME}"
  docker buildx create --name "$BUILDER_NAME" --driver docker-container --use
else
  echo "  Using existing buildx builder: ${BUILDER_NAME}"
  docker buildx use "$BUILDER_NAME"
fi

# Register QEMU for cross-platform builds
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes 2>/dev/null || true

echo ""

# ---------------------------------------------------------------------------
# Sync feature flags (needed by assistant and gateway builds)
# ---------------------------------------------------------------------------

echo "==> Syncing feature flag registry"
cp "${REPO_ROOT}/meta/feature-flags/feature-flag-registry.json" \
   "${REPO_ROOT}/assistant/src/config/feature-flag-registry.json"
cp "${REPO_ROOT}/meta/feature-flags/feature-flag-registry.json" \
   "${REPO_ROOT}/gateway/src/feature-flag-registry.json"
echo "  Done"
echo ""

# ---------------------------------------------------------------------------
# Build and push each service
# ---------------------------------------------------------------------------

FAILED_SERVICES=()

for svc in "${SELECTED_SERVICES[@]}"; do
  IMAGE="${DOCKERHUB_ORG}/${IMAGE_NAMES[$svc]}"
  CONTEXT="${REPO_ROOT}/${BUILD_CONTEXTS[$svc]}"
  DOCKERFILE="${REPO_ROOT}/${DOCKERFILES[$svc]}"

  # Build tag arguments
  TAG_ARGS=(-t "${IMAGE}:v${VERSION}")
  if [[ "$SKIP_LATEST" != "true" ]]; then
    TAG_ARGS+=(-t "${IMAGE}:latest")
  fi

  echo "==> Building and pushing: ${svc}"
  echo "    Image:      ${IMAGE}"
  echo "    Dockerfile: ${DOCKERFILES[$svc]}"
  echo "    Context:    ${BUILD_CONTEXTS[$svc]}"
  echo "    Tags:       v${VERSION}$(if [[ "$SKIP_LATEST" != "true" ]]; then echo ", latest"; fi)"
  echo ""

  BUILD_CMD=(
    docker buildx build
    --platform "${PLATFORMS}"
    -f "${DOCKERFILE}"
    "${TAG_ARGS[@]}"
  )

  if [[ "$DRY_RUN" != "true" ]]; then
    BUILD_CMD+=(--push)
  else
    echo "    (dry run — skipping push)"
  fi

  BUILD_CMD+=("${CONTEXT}")

  if "${BUILD_CMD[@]}"; then
    echo ""
    echo "    ✓ ${svc} published successfully"
  else
    echo ""
    echo "    ✗ ${svc} FAILED"
    FAILED_SERVICES+=("$svc")
  fi
  echo ""
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo "==========================================="
echo "  Docker Hub Publish Summary"
echo "==========================================="
echo "  Version: v${VERSION}"
echo ""

for svc in "${SELECTED_SERVICES[@]}"; do
  IMAGE="${DOCKERHUB_ORG}/${IMAGE_NAMES[$svc]}"
  if printf '%s\n' "${FAILED_SERVICES[@]}" 2>/dev/null | grep -qx "$svc"; then
    echo "  [FAIL] ${IMAGE}:v${VERSION}"
  elif [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY]  ${IMAGE}:v${VERSION}  (not pushed)"
  else
    echo "  [OK]   ${IMAGE}:v${VERSION}"
  fi
done
echo ""

if [[ ${#FAILED_SERVICES[@]} -gt 0 ]]; then
  echo "ERROR: ${#FAILED_SERVICES[@]} service(s) failed: ${FAILED_SERVICES[*]}"
  exit 1
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run complete — no images were pushed."
else
  echo "All images published successfully."
fi
