#!/usr/bin/env bash
#
# production-release.sh — Download the latest release DMG and install it on a Mac mini.
#
# Fetches the most recent GitHub release from vellum-ai/vellum-assistant,
# downloads vellum-assistant.dmg, SCPs it to the Mac mini, and installs
# Vellum.app into /Applications.
#
# Configuration is read from scripts/.env (see scripts/.env.example).
#
# Usage:
#   ./scripts/production-release.sh [--cleanup]
#
# Options:
#   --cleanup   Before installing, SCP the mac-mini-cleanup.sh script to the
#               mini, run it, then remove it. Resets the environment to a
#               clean state before installing the production app.

set -euo pipefail

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------

RUN_CLEANUP=false
for arg in "$@"; do
  case "$arg" in
    --cleanup) RUN_CLEANUP=true ;;
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

# SSH host of the Mac mini (required). Can include the user, e.g. user@host.
MAC_MINI_HOST="${MAC_MINI_HOST:?MAC_MINI_HOST is required -- set it in scripts/.env}"

# SSH user. Only needed if MAC_MINI_HOST doesn't already include a user@ prefix.
MAC_MINI_USER="${MAC_MINI_USER:-}"

# Password for the Mac mini (optional). When set, sshpass is used automatically.
MAC_MINI_PASSWORD="${MAC_MINI_PASSWORD:-}"

# Path to an SSH private key for the Mac mini (optional).
MAC_MINI_SSH_KEY="${MAC_MINI_SSH_KEY:-}"

# GitHub repository to fetch the release from.
GITHUB_REPO="${GITHUB_REPO:-vellum-ai/vellum-assistant}"

# ---------------------------------------------------------------------------
# Derived values
# ---------------------------------------------------------------------------

if [ -n "$MAC_MINI_USER" ]; then
  SCP_HOST="${MAC_MINI_USER}@${MAC_MINI_HOST}"
else
  SCP_HOST="${MAC_MINI_HOST}"
fi

# If a password is configured, make sure sshpass is available.
if [ -n "$MAC_MINI_PASSWORD" ] && ! command -v sshpass &>/dev/null; then
  echo "sshpass is required for password-based SSH but was not found. Installing via Homebrew..."
  brew install hudochenkov/sshpass/sshpass
fi

# Build auth-aware wrappers so every scp/ssh call inherits credentials.
remote_scp() {
  if [ -n "$MAC_MINI_PASSWORD" ]; then
    SSHPASS="$MAC_MINI_PASSWORD" sshpass -e scp -o StrictHostKeyChecking=no "$@"
  elif [ -n "$MAC_MINI_SSH_KEY" ]; then
    scp -i "$MAC_MINI_SSH_KEY" -o StrictHostKeyChecking=no "$@"
  else
    scp "$@"
  fi
}

remote_ssh() {
  if [ -n "$MAC_MINI_PASSWORD" ]; then
    SSHPASS="$MAC_MINI_PASSWORD" sshpass -e ssh -o StrictHostKeyChecking=no "$@"
  elif [ -n "$MAC_MINI_SSH_KEY" ]; then
    ssh -i "$MAC_MINI_SSH_KEY" -o StrictHostKeyChecking=no "$@"
  else
    ssh "$@"
  fi
}

# ---------------------------------------------------------------------------
# 1. Download the latest release DMG from GitHub
# ---------------------------------------------------------------------------

echo "Fetching latest release from ${GITHUB_REPO}..."

DMG_URL=$(gh release view --repo "$GITHUB_REPO" --json assets --jq '.assets[] | select(.name == "vellum-assistant.dmg") | .url')
if [ -z "$DMG_URL" ]; then
  echo "ERROR: Could not find vellum-assistant.dmg in the latest release of ${GITHUB_REPO}"
  exit 1
fi

RELEASE_TAG=$(gh release view --repo "$GITHUB_REPO" --json tagName --jq '.tagName')
echo "Latest release: ${RELEASE_TAG}"

LOCAL_DMG="/tmp/vellum-assistant.dmg"
echo "Downloading vellum-assistant.dmg..."
gh release download --repo "$GITHUB_REPO" --pattern "vellum-assistant.dmg" --dir /tmp --clobber
echo "Downloaded: ${LOCAL_DMG}"
ls -lh "$LOCAL_DMG"

# ---------------------------------------------------------------------------
# 2. (Optional) Run cleanup script on the Mac mini before installing
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
# 3. Upload to Mac mini and install into /Applications
# ---------------------------------------------------------------------------

REMOTE_DMG="/tmp/vellum-assistant.dmg"

echo "Uploading DMG to ${SCP_HOST}..."
remote_scp "$LOCAL_DMG" "${SCP_HOST}:${REMOTE_DMG}"

echo "Installing into /Applications on ${SCP_HOST}..."
remote_ssh "${SCP_HOST}" bash -s <<'REMOTE_SCRIPT'
set -euo pipefail
DMG="/tmp/vellum-assistant.dmg"

# Kill running Vellum instance if any
pkill -x "Vellum" 2>/dev/null || true
sleep 1

# Mount, copy to /Applications, unmount
MOUNT_POINT=$(hdiutil attach "$DMG" -nobrowse -noverify | grep -o '/Volumes/.*')
if [ -z "$MOUNT_POINT" ]; then
  echo "ERROR: Failed to mount DMG"
  exit 1
fi

rm -rf "/Applications/Vellum.app"
cp -R "$MOUNT_POINT/Vellum.app" "/Applications/Vellum.app"
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
rm -f "$DMG"

echo "Installed: /Applications/Vellum.app"
REMOTE_SCRIPT

rm -f "$LOCAL_DMG"

echo "Done! Vellum app installed to /Applications on ${SCP_HOST} (${RELEASE_TAG})"
