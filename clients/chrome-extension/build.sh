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

# Resolve extension version. The release workflow injects VERSION; local
# dev builds fall back to the value in the source manifest.
if [ -n "${VERSION:-}" ]; then
  EXT_VERSION="$VERSION"
else
  EXT_VERSION=$(jq -r '.version' "$SCRIPT_DIR/manifest.json")
fi

# Resolve environment for bundle-time injection. The release workflow sets
# VELLUM_ENVIRONMENT to 'staging' or 'production'; local dev builds
# default to 'dev' when the variable is unset.
VELLUM_ENV="${VELLUM_ENVIRONMENT:-dev}"

# Chrome manifest requires 1-4 dot-separated integers. Strip any
# prerelease suffix (e.g. "0.6.0-staging.3" -> "0.6.0") so staging
# builds produce a valid extension zip.
EXT_VERSION="${EXT_VERSION%%-*}"

echo "Building the Vellum Assistant Chrome extension…"

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
echo "  Environment: $VELLUM_ENV"
bun build \
  "$SCRIPT_DIR/background/worker.ts" \
  --outdir "$DIST_DIR/background" \
  --target browser \
  --format esm \
  --minify \
  --define "process.env.VELLUM_ENVIRONMENT=\"$VELLUM_ENV\""

# Build popup script
echo "Bundling popup script with bun build..."
bun build \
  "$SCRIPT_DIR/popup/popup.ts" \
  --outdir "$DIST_DIR/popup" \
  --target browser \
  --format esm \
  --minify \
  --define "process.env.VELLUM_ENVIRONMENT=\"$VELLUM_ENV\""

# Copy static assets
cp "$SCRIPT_DIR/manifest.json" "$DIST_DIR/manifest.json"

# Stamp the resolved version into the dist manifest.
jq --arg v "$EXT_VERSION" '.version = $v' "$DIST_DIR/manifest.json" > "$DIST_DIR/manifest.json.tmp" \
  && mv "$DIST_DIR/manifest.json.tmp" "$DIST_DIR/manifest.json"
echo "  Extension version: $EXT_VERSION"

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

# ---------------------------------------------------------------------------
# Packaging: produce a signed .crx for Verified CRX Uploads (CWS) and a .zip
# for local/fallback use. The private key is expected at privatekey.pem in the
# chrome-extension directory; CI injects it via secrets.
# ---------------------------------------------------------------------------
CRX_KEY_FILE="${CRX_KEY_PATH:-$SCRIPT_DIR/privatekey.pem}"
CRX_OUT="$SCRIPT_DIR/vellum-browser-relay.crx"
ZIP_OUT="$SCRIPT_DIR/vellum-browser-relay.zip"

# Detect Chrome/Chromium binary (macOS & Linux)
find_chrome() {
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome 2>/dev/null)" \
    "$(command -v google-chrome-stable 2>/dev/null)" \
    "$(command -v chromium-browser 2>/dev/null)" \
    "$(command -v chromium 2>/dev/null)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

if [ -f "$CRX_KEY_FILE" ]; then
  CHROME_BIN="$(find_chrome || true)"
  if [ -n "$CHROME_BIN" ]; then
    echo "Signing CRX with $CHROME_BIN ..."
    "$CHROME_BIN" --pack-extension="$DIST_DIR" --pack-extension-key="$CRX_KEY_FILE" 2>&1 || true
    # Chrome outputs dist.crx next to the dist/ directory
    if [ -f "$DIST_DIR.crx" ]; then
      mv "$DIST_DIR.crx" "$CRX_OUT"
      echo "  Signed CRX: $CRX_OUT"
    else
      echo "  Warning: Chrome did not produce a .crx file"
    fi
  else
    echo "  Warning: Chrome/Chromium not found — skipping CRX signing"
  fi
else
  echo "  No private key at $CRX_KEY_FILE — skipping CRX signing"
fi

# Always produce a zip as well (useful for manual uploads / fallback)
(cd "$DIST_DIR" && zip -r "$ZIP_OUT" .)
echo "  Zip: $ZIP_OUT"

echo ""
echo "To install locally:"
echo "  1. Open Chrome → chrome://extensions"
echo "  2. Enable Developer mode (top-right toggle)"
echo "  3. Click 'Load unpacked' and select: $DIST_DIR"
echo "  4. Click Connect — the token is auto-fetched from the local gateway"
