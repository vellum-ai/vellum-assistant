#!/usr/bin/env bash
# sync-lucide-icons.sh — Vendor a subset of Lucide icons as PDF assets
#
# Prerequisites: rsvg-convert (brew install librsvg), jq
#
# Usage:
#   clients/scripts/sync-lucide-icons.sh
#
# Reads the pinned tag from clients/shared/Resources/lucide-version.txt
# and the icon list from clients/shared/Resources/lucide-icon-manifest.json,
# then converts each SVG → PDF into LucideIcons/ (flat directory).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIENTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SHARED_DIR="$CLIENTS_DIR/shared"
RESOURCES_DIR="$SHARED_DIR/Resources"

VERSION_FILE="$RESOURCES_DIR/lucide-version.txt"
MANIFEST_FILE="$RESOURCES_DIR/lucide-icon-manifest.json"
ICONS_DIR="$RESOURCES_DIR/LucideIcons"

# --- Validate prerequisites ---
for cmd in rsvg-convert jq git; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is required. Install with: brew install ${cmd/git/git}" >&2
    exit 1
  fi
done

# --- Read pinned tag ---
TAG=$(grep '^tag=' "$VERSION_FILE" | cut -d= -f2)
if [[ -z "$TAG" ]]; then
  echo "ERROR: Could not read tag from $VERSION_FILE" >&2
  exit 1
fi
echo "Pinned Lucide tag: $TAG"

# --- Clone upstream at pinned tag ---
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Cloning lucide-icons/lucide at tag $TAG..."
git clone --quiet --depth=1 --branch "$TAG" "https://github.com/lucide-icons/lucide.git" "$TMPDIR/lucide"

ICONS_SRC="$TMPDIR/lucide/icons"

# --- Read icon list from manifest ---
ICONS=$(jq -r '.icons[]' "$MANIFEST_FILE")
ICON_COUNT=$(echo "$ICONS" | wc -l | tr -d ' ')
echo "Processing $ICON_COUNT icons..."

# --- Prepare output directory ---
rm -rf "$ICONS_DIR"
mkdir -p "$ICONS_DIR"

# --- Convert each icon ---
MISSING=()
CONVERTED=0

for ICON_NAME in $ICONS; do
  SVG_PATH="$ICONS_SRC/$ICON_NAME.svg"

  if [[ ! -f "$SVG_PATH" ]]; then
    MISSING+=("$ICON_NAME")
    continue
  fi

  ASSET_NAME="lucide-$ICON_NAME"

  # Convert SVG → PDF
  rsvg-convert -f pdf -o "$ICONS_DIR/$ASSET_NAME.pdf" "$SVG_PATH"

  CONVERTED=$((CONVERTED + 1))
done

echo "Converted $CONVERTED icons."

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo ""
  echo "WARNING: ${#MISSING[@]} icon(s) not found in Lucide at $TAG:"
  for m in "${MISSING[@]}"; do
    echo "  - $m"
  done
  exit 1
fi

echo "Done. Assets written to $ICONS_DIR"
