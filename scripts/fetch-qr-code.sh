#!/usr/bin/env bash
#
# fetch-qr-code.sh — SCP the pairing QR code PNG from a Mac mini to this machine.
#
# After running `curl -fsSL https://vellum.ai/install.sh | bash` on a
# Mac mini, this script copies the generated QR code PNG to a well-known local
# XDG data path so the Desktop app can auto-detect it for pairing.
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

# ---------------------------------------------------------------------------
# Hardcoded paths
# ---------------------------------------------------------------------------

# Remote path on the Mac mini where `vellum hatch` saves the QR code PNG.
QR_CODE_REMOTE_PATH='~/.vellum/pairing-qr/initial.png'

# Local XDG data path so the Desktop app can auto-detect the file.
LOCAL_DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/vellum/pairing-qr"
LOCAL_DEST="${LOCAL_DEST_DIR}/initial.png"

# ---------------------------------------------------------------------------
# Derived values
# ---------------------------------------------------------------------------

if [ -n "$MAC_MINI_USER" ]; then
  SCP_HOST="${MAC_MINI_USER}@${MAC_MINI_HOST}"
else
  SCP_HOST="${MAC_MINI_HOST}"
fi

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo "Fetching QR code from ${SCP_HOST}:${QR_CODE_REMOTE_PATH} ..."

mkdir -p "$LOCAL_DEST_DIR"

scp "${SCP_HOST}:${QR_CODE_REMOTE_PATH}" "$LOCAL_DEST"

echo "QR code saved to ${LOCAL_DEST}"
