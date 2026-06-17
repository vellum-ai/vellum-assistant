#!/usr/bin/env bash
set -euo pipefail

# Sync the public OpenAPI specs from a local platform repo checkout.
#
# The specs (platform.yaml, auth.yaml) are committed to this repo so that
# anyone — including open-source contributors — can run `bun run openapi-ts`
# without access to the private platform repo.
#
# Vellum developers: run this script after the platform repo regenerates
# its specs to update the committed copies here.
#
# Usage:
#   ./scripts/sync-openapi-specs.sh [path-to-platform-openapi-schemas-dir]
#
# Resolution order:
#   1. Explicit directory argument
#   2. PLATFORM_OPENAPI_DIR environment variable
#   3. Sibling checkout: ../vellum-assistant-platform/django/openapi_schemas/

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$WEB_DIR/openapi-schemas"

SIBLING_DEFAULT="$WEB_DIR/../../../vellum-assistant-platform/django/openapi_schemas"
SCHEMAS_DIR="${1:-${PLATFORM_OPENAPI_DIR:-$SIBLING_DEFAULT}}"

# Only sync the public-facing specs. internal.yaml stays private.
SPECS=("platform.yaml" "auth.yaml")

for spec in "${SPECS[@]}"; do
  src="$SCHEMAS_DIR/$spec"
  if [ ! -f "$src" ]; then
    echo "Error: $spec not found at: $src"
    echo ""
    echo "Usage: $0 [path-to-platform-openapi-schemas-dir]"
    echo ""
    echo "You can also set PLATFORM_OPENAPI_DIR."
    echo ""
    echo "Default location checked:"
    echo "  $SIBLING_DEFAULT"
    exit 1
  fi
done

mkdir -p "$OUTPUT_DIR"
for spec in "${SPECS[@]}"; do
  cp "$SCHEMAS_DIR/$spec" "$OUTPUT_DIR/$spec"
  echo "Synced $spec"
done

echo ""
echo "Specs updated in $OUTPUT_DIR"
echo "Run 'bun run openapi-ts' to regenerate the client, then commit both."
