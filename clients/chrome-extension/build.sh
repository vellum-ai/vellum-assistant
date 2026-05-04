#!/usr/bin/env bash
# Build the Chrome extension using Bun.
# Output goes to clients/chrome-extension/dist/.
#
# Usage:
#   cd clients/chrome-extension && bash build.sh [command]
#
# Commands:
#   build (default)   Build the extension for distribution
#   run               Build + watch for local development (rebuilds on source changes)
#   release           Build a release (VELLUM_ENVIRONMENT defaults to 'production')
#
# After building, load the dist/ directory as an unpacked extension in Chrome.
# In `run` mode the script stays alive and rebuilds whenever source files change.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"

# Parse subcommand
CMD="${1:-build}"
case "$CMD" in
  build|run|release) ;;
  *)
    echo "Unknown command: $CMD"
    echo "Usage: bash build.sh [build|run|release]"
    exit 1
    ;;
esac

# Resolve extension version. The release workflow injects VERSION; local
# dev builds fall back to the value in the source manifest.
if [ -n "${VERSION:-}" ]; then
  EXT_VERSION="$VERSION"
else
  EXT_VERSION=$(jq -r '.version' "$SCRIPT_DIR/manifest.json")
fi

# Resolve environment for bundle-time injection. CI and developers can
# always override by exporting VELLUM_ENVIRONMENT before invoking the
# script — the explicit value takes precedence.
#
# Defaults per subcommand (when VELLUM_ENVIRONMENT is unset):
#   run     => local   (for local full-stack development)
#   release => production
#   build   => dev
if [ -z "${VELLUM_ENVIRONMENT:-}" ]; then
  case "$CMD" in
    run)     VELLUM_ENV="local" ;;
    release) VELLUM_ENV="production" ;;
    *)       VELLUM_ENV="dev" ;;
  esac
else
  VELLUM_ENV="$VELLUM_ENVIRONMENT"
fi

# Preserve the full version string (including prerelease suffix) for
# `version_name` in the manifest so build provenance is always visible.
EXT_VERSION_FULL="$EXT_VERSION"

# Chrome manifest requires 1-4 dot-separated integers. Strip any
# prerelease suffix (e.g. "0.6.0-staging.3" -> "0.6.0") so staging
# builds produce a valid extension zip.
EXT_VERSION="${EXT_VERSION%%-*}"

# ---------------------------------------------------------------------------
# Build function — shared by initial build and watch-triggered rebuilds.
# ---------------------------------------------------------------------------
do_build() {
  echo "Building the Vellum Assistant Chrome extension…"
  echo "  Command: $CMD"

  echo "Type-checking with tsc --noEmit..."
  if ! (cd "$SCRIPT_DIR" && bunx tsc --noEmit); then
    echo "❌ Type-check failed."
    return 1
  fi

  rm -rf "$DIST_DIR"
  mkdir -p "$DIST_DIR/background"
  mkdir -p "$DIST_DIR/popup"
  mkdir -p "$DIST_DIR/icons"

  echo "Bundling service worker with bun build..."
  echo "  Environment: $VELLUM_ENV"
  bun build \
    "$SCRIPT_DIR/background/worker.ts" \
    --outdir "$DIST_DIR/background" \
    --target browser \
    --format esm \
    --minify \
    --define "process.env.VELLUM_ENVIRONMENT=\"$VELLUM_ENV\"" \
    || { echo "❌ Service worker bundle failed."; return 1; }

  echo "Bundling popup script with bun build..."
  bun build \
    "$SCRIPT_DIR/popup/popup.ts" \
    --outdir "$DIST_DIR/popup" \
    --target browser \
    --format esm \
    --minify \
    --define "process.env.VELLUM_ENVIRONMENT=\"$VELLUM_ENV\"" \
    || { echo "❌ Popup bundle failed."; return 1; }

  cp "$SCRIPT_DIR/manifest.json" "$DIST_DIR/manifest.json" \
    || { echo "❌ Failed to copy manifest."; return 1; }

  jq --arg v "$EXT_VERSION" --arg vn "$EXT_VERSION_FULL" \
    '.version = $v | .version_name = $vn' \
    "$DIST_DIR/manifest.json" > "$DIST_DIR/manifest.json.tmp" \
    && mv "$DIST_DIR/manifest.json.tmp" "$DIST_DIR/manifest.json" \
    || { echo "❌ Failed to stamp version."; return 1; }
  echo "  Extension version: $EXT_VERSION (full: $EXT_VERSION_FULL)"

  case "$VELLUM_ENV" in
    production) EXT_NAME="Vellum Assistant" ;;
    *)          EXT_NAME="Vellum Assistant $(echo "$VELLUM_ENV" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')" ;;
  esac
  jq --arg n "$EXT_NAME" '.name = $n' "$DIST_DIR/manifest.json" > "$DIST_DIR/manifest.json.tmp" \
    && mv "$DIST_DIR/manifest.json.tmp" "$DIST_DIR/manifest.json" \
    || { echo "❌ Failed to stamp name."; return 1; }
  echo "  Extension name: $EXT_NAME"

  # Inject a deterministic public key for non-production builds so every
  # developer running the same environment gets the same stable extension ID.
  # Production builds omit the key — Chrome uses the CWS signing key instead.
  # The mapping lives in extension-environments.json alongside this script.
  ENV_KEY=$(jq -r --arg e "$VELLUM_ENV" '.[$e].key // empty' "$SCRIPT_DIR/extension-environments.json")
  ENV_EXT_ID=$(jq -r --arg e "$VELLUM_ENV" '.[$e].extensionId // empty' "$SCRIPT_DIR/extension-environments.json")
  if [ -n "$ENV_KEY" ]; then
    jq --arg k "$ENV_KEY" '.key = $k' "$DIST_DIR/manifest.json" > "$DIST_DIR/manifest.json.tmp" \
      && mv "$DIST_DIR/manifest.json.tmp" "$DIST_DIR/manifest.json" \
      || { echo "❌ Failed to inject extension key."; return 1; }
  fi
  if [ -n "$ENV_EXT_ID" ]; then
    echo "  Extension ID: $ENV_EXT_ID"
  fi

  cp "$SCRIPT_DIR/popup/popup.html" "$DIST_DIR/popup/popup.html" \
    || { echo "❌ Failed to copy popup HTML."; return 1; }

  # Copy all icon directories into dist — the background worker dynamically
  # switches the toolbar icon when the user overrides the environment via
  # the popup dropdown, so every env's icons must be available at runtime.
  # The manifest's `icons` field is set to the build-time env so Chrome's
  # chrome://extensions page shows the right default.
  if [ -d "$SCRIPT_DIR/icons" ] && [ "$(ls -A "$SCRIPT_DIR/icons" 2>/dev/null)" ]; then
    cp -r "$SCRIPT_DIR/icons/." "$DIST_DIR/icons/"
    jq --arg e "$VELLUM_ENV" \
      '.icons = { "16": "icons/\($e)/icon16.png", "48": "icons/\($e)/icon48.png", "128": "icons/\($e)/icon128.png" }' \
      "$DIST_DIR/manifest.json" > "$DIST_DIR/manifest.json.tmp" \
      && mv "$DIST_DIR/manifest.json.tmp" "$DIST_DIR/manifest.json"
    echo "  Icons: $VELLUM_ENV (all envs bundled)"
  else
    echo "  (No icons found — creating placeholder icon files)"
    TINY_PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    for size in 16 48 128; do
      echo "$TINY_PNG_B64" | base64 --decode > "$DIST_DIR/icons/icon${size}.png"
    done
  fi

  echo ""
  echo "✅ Extension built to: $DIST_DIR"
}

# ---------------------------------------------------------------------------
# Initial build
# ---------------------------------------------------------------------------
if [ "$CMD" = "run" ]; then
  # In run mode, don't exit on initial build failure — enter the watch loop
  # so the developer can fix files and get an automatic rebuild.
  if ! do_build; then
    echo ""
    echo "⚠️  Initial build failed. Entering watch mode — will rebuild on next change."
    echo ""
  fi
else
  do_build
fi

# ---------------------------------------------------------------------------
# Watch mode (run only) — poll for source changes and rebuild automatically.
# Stays alive until Ctrl-C. Skips packaging (CRX/zip) since dev builds don't
# need it.
# ---------------------------------------------------------------------------
if [ "$CMD" = "run" ]; then
  WATCH_DIRS=("background" "popup" "types" "icons")
  WATCH_FILES=("manifest.json" "package.json" "tsconfig.json")
  POLL_INTERVAL=3
  DEBOUNCE=2

  # Snapshot initial mtime of the dist manifest as our baseline.
  BASELINE_MTIME=$(stat -f '%m' "$DIST_DIR/manifest.json" 2>/dev/null || stat -c '%Y' "$DIST_DIR/manifest.json" 2>/dev/null || echo 0)

  echo ""
  echo "👀 Watching for changes (poll every ${POLL_INTERVAL}s)..."
  echo "   Dirs:  ${WATCH_DIRS[*]}"
  echo "   Files: ${WATCH_FILES[*]}"
  echo "   Press Ctrl-C to stop."
  echo ""

  trap 'echo ""; echo "🛑 Watch stopped."; exit 0' INT TERM

  while true; do
  sleep "$POLL_INTERVAL"

  # Check if any source file is newer than the last build output.
  # If dist/manifest.json doesn't exist (build never succeeded), always rebuild.
  CHANGED=0
  if [ ! -f "$DIST_DIR/manifest.json" ]; then
    CHANGED=1
  else
    for d in "${WATCH_DIRS[@]}"; do
      [ -d "$SCRIPT_DIR/$d" ] || continue
      if [ -n "$(find "$SCRIPT_DIR/$d" -type f -newer "$DIST_DIR/manifest.json" -print -quit 2>/dev/null)" ]; then
        CHANGED=1
        break
      fi
    done
    if [ "$CHANGED" -eq 0 ]; then
      for f in "${WATCH_FILES[@]}"; do
        [ -f "$SCRIPT_DIR/$f" ] || continue
        FILE_MTIME=$(stat -f '%m' "$SCRIPT_DIR/$f" 2>/dev/null || stat -c '%Y' "$SCRIPT_DIR/$f" 2>/dev/null || echo 0)
        if [ "$FILE_MTIME" -gt "$BASELINE_MTIME" ]; then
          CHANGED=1
          break
        fi
      done
    fi
  fi

  [ "$CHANGED" -eq 0 ] && continue

    # Debounce — wait for rapid saves to settle.
    sleep "$DEBOUNCE"

    echo ""
    echo "🔄 Source changed. Rebuilding..."
    echo ""
    if do_build; then
      BASELINE_MTIME=$(stat -f '%m' "$DIST_DIR/manifest.json" 2>/dev/null || stat -c '%Y' "$DIST_DIR/manifest.json" 2>/dev/null || echo 0)
      echo ""
      echo "   Reload in chrome://extensions to pick up changes."
      echo ""
    else
      echo ""
      echo "❌ Build failed. Will retry on next change."
      echo ""
    fi
  done

  # run mode never reaches here — the loop runs until Ctrl-C
  exit 0
fi

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
