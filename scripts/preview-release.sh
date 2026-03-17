#!/usr/bin/env bash
#
# preview-release.sh — Download a PR preview DMG artifact and install it on a Mac mini.
#
# Fetches the DMG artifact built by the "PR macOS Build Check" workflow for
# the given pull request number, SCPs it to the Mac mini, and installs the
# preview app into /Applications.
#
# Configuration is read from scripts/.env (see scripts/.env.example).
#
# Usage:
#   ./scripts/preview-release.sh --pr <number> [--cleanup]
#
# Options:
#   --pr <number>   PR number whose DMG artifact should be downloaded and
#                   installed (required).
#   --cleanup       Before installing, SCP the mac-mini-cleanup.sh script to
#                   the mini, run it, then remove it. Resets the environment
#                   to a clean state before installing the preview app.

set -euo pipefail

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------

RUN_CLEANUP=false
PR_NUMBER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cleanup)
      RUN_CLEANUP=true
      shift
      ;;
    --pr)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --pr requires a PR number"
        exit 1
      fi
      PR_NUMBER="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 --pr <number> [--cleanup]"
      exit 1
      ;;
  esac
done

if [[ -z "$PR_NUMBER" ]]; then
  echo "ERROR: --pr <number> is required"
  echo "Usage: $0 --pr <number> [--cleanup]"
  exit 1
fi

if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "ERROR: PR number must be a positive integer, got: $PR_NUMBER"
  exit 1
fi

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
MAC_MINI_PASSWORD=${MAC_MINI_PASSWORD:-}

# Path to an SSH private key for the Mac mini (optional).
MAC_MINI_SSH_KEY="${MAC_MINI_SSH_KEY:-}"

# GitHub repository to fetch the artifact from.
GITHUB_REPO="${GITHUB_REPO:-vellum-ai/vellum-assistant}"

# ---------------------------------------------------------------------------
# Derived values
# ---------------------------------------------------------------------------

if [ -n "$MAC_MINI_USER" ]; then
  SCP_HOST="${MAC_MINI_USER}@${MAC_MINI_HOST}"
else
  SCP_HOST="${MAC_MINI_HOST}"
fi

ARTIFACT_NAME="vellum-assistant-pr-${PR_NUMBER}.dmg"
APP_DISPLAY_NAME="Vellum ${PR_NUMBER}"

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
# 1. Download the DMG artifact from the PR's CI run
# ---------------------------------------------------------------------------

echo "Fetching artifact '${ARTIFACT_NAME}' for PR #${PR_NUMBER} from ${GITHUB_REPO}..."

# Find the workflow run for the PR that produced the artifact.
# The PR macOS Build Check workflow uploads artifacts named
# "vellum-assistant-pr-<number>.dmg".
LOCAL_DMG_DIR="/tmp/preview-release-${PR_NUMBER}"
LOCAL_DMG="${LOCAL_DMG_DIR}/${ARTIFACT_NAME}"
rm -rf "$LOCAL_DMG_DIR"

gh run download \
  --repo "$GITHUB_REPO" \
  --name "$ARTIFACT_NAME" \
  --dir "$LOCAL_DMG_DIR" \
  || {
    echo "ERROR: Could not download artifact '${ARTIFACT_NAME}' from ${GITHUB_REPO}."
    echo "Make sure the PR has the 'preview' label and the macOS build has completed."
    exit 1
  }

# gh run download extracts the artifact into the directory. The DMG file
# inside has the same name as the artifact.
if [ ! -f "$LOCAL_DMG" ]; then
  # The artifact may have been extracted without the .dmg wrapper name;
  # look for any .dmg inside the directory.
  FOUND_DMG=$(find "$LOCAL_DMG_DIR" -name '*.dmg' -type f | head -1)
  if [ -n "$FOUND_DMG" ]; then
    LOCAL_DMG="$FOUND_DMG"
  else
    echo "ERROR: No DMG file found in downloaded artifact at ${LOCAL_DMG_DIR}"
    ls -la "$LOCAL_DMG_DIR"
    exit 1
  fi
fi

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

REMOTE_DMG="/tmp/${ARTIFACT_NAME}"

echo "Uploading DMG to ${SCP_HOST}..."
remote_scp "$LOCAL_DMG" "${SCP_HOST}:${REMOTE_DMG}"

echo "Installing into /Applications on ${SCP_HOST}..."
remote_ssh "${SCP_HOST}" bash -s -- "$REMOTE_DMG" "$APP_DISPLAY_NAME" <<'REMOTE_SCRIPT'
set -euo pipefail
DMG="$1"
APP_NAME="$2"

# Kill running preview instance if any
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 1

# Mount, copy to /Applications, unmount
MOUNT_POINT=$(hdiutil attach "$DMG" -nobrowse -noverify | grep -o '/Volumes/.*')
if [ -z "$MOUNT_POINT" ]; then
  echo "ERROR: Failed to mount DMG"
  exit 1
fi

rm -rf "/Applications/${APP_NAME}.app"
cp -R "$MOUNT_POINT/${APP_NAME}.app" "/Applications/${APP_NAME}.app"
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
rm -f "$DMG"

echo "Installed: /Applications/${APP_NAME}.app"
REMOTE_SCRIPT

rm -rf "$LOCAL_DMG_DIR"

echo "Done! Preview app '${APP_DISPLAY_NAME}' installed to /Applications on ${SCP_HOST} (PR #${PR_NUMBER})"
