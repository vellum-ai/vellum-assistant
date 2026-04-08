#!/usr/bin/env bash
# Build the Chrome extension using Bun.
# Output goes to clients/chrome-extension/dist/.
#
# Usage:
#   cd clients/chrome-extension && bash build.sh
#   Then load the dist/ directory as an unpacked extension in Chrome.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"

echo "Building Vellum browser-relay extension…"

# Type-check with tsc --noEmit before bundling so type errors fail fast
# rather than surfacing as runtime errors in the loaded extension. `bun build`
# does not run a TypeScript check — it strips types and bundles.
echo "Type-checking with tsc --noEmit..."
(cd "$SCRIPT_DIR" && bunx tsc --noEmit)

# Clean previous build
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/background"
mkdir -p "$DIST_DIR/popup"
mkdir -p "$DIST_DIR/icons"

# Build service worker
echo "Bundling service worker with bun build..."
bun build \
  "$SCRIPT_DIR/background/worker.ts" \
  --outdir "$DIST_DIR/background" \
  --target browser \
  --format esm \
  --minify

# Build popup script
echo "Bundling popup script with bun build..."
bun build \
  "$SCRIPT_DIR/popup/popup.ts" \
  --outdir "$DIST_DIR/popup" \
  --target browser \
  --format esm \
  --minify

# Copy static assets
cp "$SCRIPT_DIR/manifest.json" "$DIST_DIR/manifest.json"
cp "$SCRIPT_DIR/popup/popup.html" "$DIST_DIR/popup/popup.html"

# Copy icons if they exist, otherwise create placeholder PNGs
if [ -d "$SCRIPT_DIR/icons" ] && [ "$(ls -A "$SCRIPT_DIR/icons" 2>/dev/null)" ]; then
  cp -r "$SCRIPT_DIR/icons/." "$DIST_DIR/icons/"
else
  echo "  (No icons found — creating placeholder icon files)"
  # Create minimal 1×1 transparent PNG for each size
  TINY_PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  for size in 16 48 128; do
    echo "$TINY_PNG_B64" | base64 --decode > "$DIST_DIR/icons/icon${size}.png"
  done
fi

echo ""
echo "Done! Extension built to: $DIST_DIR"
echo ""
echo "To install:"
echo "  1. Open Chrome → chrome://extensions"
echo "  2. Enable Developer mode (top-right toggle)"
echo "  3. Click 'Load unpacked' and select: $DIST_DIR"
echo "  4. Click Connect — the token is auto-fetched from the local gateway"
