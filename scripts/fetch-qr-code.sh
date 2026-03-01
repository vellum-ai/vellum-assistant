#!/usr/bin/env bash
#
# fetch-qr-code.sh — SCP the pairing QR code PNG from a Mac mini to this machine.
#
# After running `curl -fsSL https://assistant.vellum.ai/install.sh | bash` on a
# Mac mini, this script copies the generated QR code PNG back to your local
# ~/Downloads directory so you can use it for pairing (e.g. via the macOS
# onboarding flow or `vellum pair <path>`).
#
# Configuration is read from scripts/.env (see scripts/.env.example).
#
# Usage:
#   ./scripts/fetch-qr-code.sh

set -euo pipefail

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
MAC_MINI_HOST="${MAC_MINI_HOST:?MAC_MINI_HOST is required — set it in scripts/.env}"

# SSH user. Only needed if MAC_MINI_HOST doesn't already include a user@ prefix.
MAC_MINI_USER="${MAC_MINI_USER:-}"

# Path to the QR code PNG on the Mac mini.
QR_CODE_REMOTE_PATH="${QR_CODE_REMOTE_PATH:-~/.vellum/pairing-qr.png}"

# Local directory to copy the QR code into.
LOCAL_DEST_DIR="${LOCAL_DEST_DIR:-$HOME/Downloads}"

# ---------------------------------------------------------------------------
# Derived values
# ---------------------------------------------------------------------------

if [ -n "$MAC_MINI_USER" ]; then
  SCP_HOST="${MAC_MINI_USER}@${MAC_MINI_HOST}"
else
  SCP_HOST="${MAC_MINI_HOST}"
fi

LOCAL_DEST="${LOCAL_DEST_DIR}/pairing-qr.png"

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo "Fetching QR code from ${SCP_HOST}:${QR_CODE_REMOTE_PATH} ..."

mkdir -p "$LOCAL_DEST_DIR"

scp "${SCP_HOST}:${QR_CODE_REMOTE_PATH}" "$LOCAL_DEST"

echo "QR code saved to ${LOCAL_DEST}"
