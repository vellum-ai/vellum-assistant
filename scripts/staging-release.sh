#!/usr/bin/env bash
#
# staging-release.sh — Build a staging release DMG and upload it to a Mac mini.
#
# Runs `./build.sh release` with BUNDLE_DISPLAY_NAME="Vellum (Staging)" so
# that "(Staging)" appears in the About Vellum modal, then packages the
# resulting .app into a DMG, SCPs it to a Mac mini, and installs the app
# into /Applications.
#
# Configuration is read from scripts/.env (see scripts/.env.example).
#
# Usage:
#   ./scripts/staging-release.sh [--cleanup] [--intel]
#
# Options:
#   --cleanup   Before installing, SCP the mac-mini-cleanup.sh script to the
#               mini, run it, then remove it. Resets the environment to a
#               clean state before installing the staging app.
#   --intel     Build for x86_64 (Intel) instead of arm64 (Apple Silicon)
#               and deploy to the Intel Mac specified by INTEL_HOST in
#               scripts/.env. Uses INTEL_PASSWORD for SSH auth if set.

set -euo pipefail

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------

RUN_CLEANUP=false
INTEL_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --cleanup) RUN_CLEANUP=true ;;
    --intel) INTEL_BUILD=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

# ---------------------------------------------------------------------------
# Configuration (override via scripts/.env or environment)
# ---------------------------------------------------------------------------

# SSH host of the Mac mini (required unless --intel is used).
if [ "$INTEL_BUILD" = true ]; then
  MAC_MINI_HOST="${MAC_MINI_HOST:-}"
else
  MAC_MINI_HOST="${MAC_MINI_HOST:?MAC_MINI_HOST is required -- set it in scripts/.env}"
fi

# SSH user. Only needed if MAC_MINI_HOST doesn't already include a user@ prefix.
MAC_MINI_USER="${MAC_MINI_USER:-}"

# Password for the Mac mini (optional). When set, sshpass is used automatically.
MAC_MINI_PASSWORD="${MAC_MINI_PASSWORD:-}"

# Path to an SSH private key for the Mac mini (optional).
MAC_MINI_SSH_KEY="${MAC_MINI_SSH_KEY:-}"

# Intel Mac SSH host (required when --intel is used).
INTEL_HOST="${INTEL_HOST:-}"

# Password for the Intel Mac (optional). When set, sshpass is used for SSH.
INTEL_PASSWORD="${INTEL_PASSWORD:-}"

if [ "$INTEL_BUILD" = true ] && [ -z "$INTEL_HOST" ]; then
  echo "ERROR: --intel requires INTEL_HOST to be set in scripts/.env"
  exit 1
fi

# ---------------------------------------------------------------------------
# Derived values
# ---------------------------------------------------------------------------

if [ "$INTEL_BUILD" = true ]; then
  SCP_HOST="${INTEL_HOST}"
  ACTIVE_PASSWORD="${INTEL_PASSWORD}"
  ACTIVE_SSH_KEY=""
else
  if [ -n "$MAC_MINI_USER" ]; then
    SCP_HOST="${MAC_MINI_USER}@${MAC_MINI_HOST}"
  else
    SCP_HOST="${MAC_MINI_HOST}"
  fi
  ACTIVE_PASSWORD="${MAC_MINI_PASSWORD}"
  ACTIVE_SSH_KEY="${MAC_MINI_SSH_KEY}"
fi

# If a password is configured, make sure sshpass is available.
if [ -n "$ACTIVE_PASSWORD" ] && ! command -v sshpass &>/dev/null; then
  echo "sshpass is required for password-based SSH but was not found. Installing via Homebrew..."
  brew install hudochenkov/sshpass/sshpass
fi

# Build auth-aware wrappers so every scp/ssh call inherits credentials.
remote_scp() {
  if [ -n "$ACTIVE_PASSWORD" ]; then
    SSHPASS="$ACTIVE_PASSWORD" sshpass -e scp -o StrictHostKeyChecking=no "$@"
  elif [ -n "$ACTIVE_SSH_KEY" ]; then
    scp -i "$ACTIVE_SSH_KEY" -o StrictHostKeyChecking=no "$@"
  else
    scp "$@"
  fi
}

remote_ssh() {
  if [ -n "$ACTIVE_PASSWORD" ]; then
    SSHPASS="$ACTIVE_PASSWORD" sshpass -e ssh -o StrictHostKeyChecking=no "$@"
  elif [ -n "$ACTIVE_SSH_KEY" ]; then
    ssh -i "$ACTIVE_SSH_KEY" -o StrictHostKeyChecking=no "$@"
  else
    ssh "$@"
  fi
}

MACOS_BUILD_DIR="$SCRIPT_DIR/../clients/macos"

# ---------------------------------------------------------------------------
# 1. Build the staging release
# ---------------------------------------------------------------------------

export BUNDLE_DISPLAY_NAME="Vellum (Staging)"
export COMMIT_SHA="${COMMIT_SHA:-$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo "")}"

if [ "$INTEL_BUILD" = true ]; then
  export RELEASE_ARCH_FLAGS="--arch x86_64"
  echo "Building staging release (x86_64 / Intel)..."
else
  echo "Building staging release (arm64)..."
fi
if [ "$INTEL_BUILD" = true ]; then
  "$MACOS_BUILD_DIR/build.sh" release --universal
else
  "$MACOS_BUILD_DIR/build.sh" release
fi

# ---------------------------------------------------------------------------
# 2. Package the .app into a DMG
# ---------------------------------------------------------------------------

APP_DIR="$MACOS_BUILD_DIR/dist/${BUNDLE_DISPLAY_NAME}.app"
if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: Built app not found at $APP_DIR"
  exit 1
fi

DMG_BUILD_DIR="$MACOS_BUILD_DIR/build"
DMG_PATH="$DMG_BUILD_DIR/vellum-assistant-staging.dmg"
DMG_STAGING="$DMG_BUILD_DIR/dmg-staging"

mkdir -p "$DMG_BUILD_DIR"
rm -rf "$DMG_STAGING" "$DMG_PATH"
mkdir -p "$DMG_STAGING"

echo "Creating staging DMG..."
cp -R "$APP_DIR" "$DMG_STAGING/"
ln -s /Applications "$DMG_STAGING/Applications"

if command -v create-dmg &>/dev/null; then
  # Use pre-generated DMG background if available
  DMG_BG_FILE="$MACOS_BUILD_DIR/dmg/dmg-background@2x.png"
  DMG_BG_ARGS=()
  if [ -f "$DMG_BG_FILE" ]; then
    DMG_BG_ARGS=(--background "$DMG_BG_FILE")
  else
    # Fall back to generating at runtime if the pre-rendered file is missing
    DMG_BG_SCRIPT="$MACOS_BUILD_DIR/dmg/generate-background.swift"
    if [ -f "$DMG_BG_SCRIPT" ]; then
      swift "$DMG_BG_SCRIPT" "$DMG_BUILD_DIR/dmg-background@2x.png" 2>/dev/null || true
      if [ -f "$DMG_BUILD_DIR/dmg-background@2x.png" ]; then
        DMG_BG_ARGS=(--background "$DMG_BUILD_DIR/dmg-background@2x.png")
      fi
    fi
  fi

  create-dmg \
    --volname "Vellum (Staging)" \
    "${DMG_BG_ARGS[@]}" \
    --window-pos 200 120 \
    --window-size 660 400 \
    --icon-size 128 \
    --text-size 10 \
    --icon "${BUNDLE_DISPLAY_NAME}.app" 175 190 \
    --icon "Applications" 530 190 \
    --hide-extension "${BUNDLE_DISPLAY_NAME}.app" \
    --no-internet-enable \
    "$DMG_PATH" \
    "$DMG_STAGING/" \
  || {
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 2 ] && [ -f "$DMG_PATH" ]; then
      echo "create-dmg exited with warning (code 2), but DMG was created successfully"
    else
      echo "create-dmg failed with exit code $EXIT_CODE"
      exit $EXIT_CODE
    fi
  }
else
  echo "(create-dmg not found, using hdiutil -- install via 'brew install create-dmg' for nicer DMGs)"
  hdiutil create -volname "Vellum (Staging)" -srcfolder "$DMG_STAGING" -ov -format UDZO "$DMG_PATH"
fi

echo "DMG created: $DMG_PATH"
ls -lh "$DMG_PATH"

# Sign the DMG if a real signing identity is available
SIGN_IDENTITY="${SIGN_IDENTITY:-}"
if [ -n "$SIGN_IDENTITY" ] && [ "$SIGN_IDENTITY" != "-" ]; then
  echo "Signing DMG..."
  codesign --sign "$SIGN_IDENTITY" --timestamp "$DMG_PATH" 2>/dev/null || \
    codesign --sign "$SIGN_IDENTITY" "$DMG_PATH"
  codesign --verify --verbose "$DMG_PATH"
  echo "DMG signature verified"
fi

rm -rf "$DMG_STAGING"

# ---------------------------------------------------------------------------
# 3. (Optional) Run cleanup script on the Mac mini before installing
# ---------------------------------------------------------------------------

if [ "$RUN_CLEANUP" = true ]; then
  CLEANUP_SCRIPT="${SCRIPT_DIR}/mac-mini-cleanup.sh"
  REMOTE_CLEANUP="/tmp/mac-mini-cleanup.sh"

  if [ ! -f "$CLEANUP_SCRIPT" ]; then
    echo "ERROR: Cleanup script not found at $CLEANUP_SCRIPT"
    exit 1
  fi

  echo "Uploading cleanup script to ${SCP_HOST}..."
  remote_scp "$CLEANUP_SCRIPT" "${SCP_HOST}:${REMOTE_CLEANUP}"

  echo "Running cleanup script on ${SCP_HOST}..."
  remote_ssh "${SCP_HOST}" "bash '${REMOTE_CLEANUP}'; rc=\$?; rm -f '${REMOTE_CLEANUP}'; exit \$rc"

  echo "Cleanup complete on ${SCP_HOST}."
fi

# ---------------------------------------------------------------------------
# 4. Upload to Mac mini and install into /Applications
# ---------------------------------------------------------------------------

REMOTE_DMG="/tmp/vellum-assistant-staging.dmg"

echo "Uploading DMG to ${SCP_HOST}..."
remote_scp "$DMG_PATH" "${SCP_HOST}:${REMOTE_DMG}"

echo "Installing into /Applications on ${SCP_HOST}..."
remote_ssh "${SCP_HOST}" bash -s <<'REMOTE_SCRIPT'
set -euo pipefail
DMG="/tmp/vellum-assistant-staging.dmg"

# Kill running staging instance if any
pkill -x "Vellum (Staging)" 2>/dev/null || true
sleep 1

# Mount, copy to /Applications, unmount
MOUNT_POINT=$(hdiutil attach "$DMG" -nobrowse -noverify | grep -o '/Volumes/.*')
if [ -z "$MOUNT_POINT" ]; then
  echo "ERROR: Failed to mount DMG"
  exit 1
fi

rm -rf "/Applications/Vellum (Staging).app"
cp -R "$MOUNT_POINT/Vellum (Staging).app" "/Applications/Vellum (Staging).app"
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
rm -f "$DMG"

echo "Installed: /Applications/Vellum (Staging).app"
REMOTE_SCRIPT

echo "Done! Staging app installed to /Applications on ${SCP_HOST}"
