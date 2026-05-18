#!/usr/bin/env bash
set -euo pipefail

# Copy the platform OpenAPI spec into the local openapi-schemas/ directory.
# This directory is gitignored — specs are never committed to this repo.
#
# Usage:
#   ./scripts/copy-openapi-spec.sh [path-to-platform.yaml]
#
# Resolution order:
#   1. Explicit path argument
#   2. PLATFORM_REPO_SPEC environment variable
#   3. Sibling checkout: ../vellum-assistant-platform/django/openapi_schemas/platform.yaml

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$WEB_DIR/openapi-schemas"

SIBLING_DEFAULT="$WEB_DIR/../../../vellum-assistant-platform/django/openapi_schemas/platform.yaml"
PLATFORM_SPEC="${1:-${PLATFORM_REPO_SPEC:-$SIBLING_DEFAULT}}"

if [ ! -f "$PLATFORM_SPEC" ]; then
  echo "Error: OpenAPI spec not found at: $PLATFORM_SPEC"
  echo ""
  echo "Usage: $0 [path-to-platform.yaml]"
  echo ""
  echo "You can also set PLATFORM_REPO_SPEC to the spec path."
  echo ""
  echo "Default location checked:"
  echo "  $SIBLING_DEFAULT"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
cp "$PLATFORM_SPEC" "$OUTPUT_DIR/platform.yaml"

echo "Copied OpenAPI spec to $OUTPUT_DIR/platform.yaml"
echo "Run 'bun run openapi-ts' to regenerate the client."
