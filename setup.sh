#!/usr/bin/env bash
#
# setup.sh — One-time local development setup for vellum-assistant.
#
# Installs dependencies for all packages (cli, gateway, assistant, meta)
# and links the global `vellum` command to the local meta entry point.
#
# Usage:
#   ./setup.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

info()  { echo "==> $*"; }
error() { echo "error: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Pre-flight: ensure bun is available
# ---------------------------------------------------------------------------
if ! command -v bun &>/dev/null; then
  error "bun is not installed. Install it from https://bun.sh and try again."
fi

# ---------------------------------------------------------------------------
# Install dependencies for each package
# ---------------------------------------------------------------------------
for dir in cli gateway assistant meta; do
  info "Installing dependencies in ${dir}/"
  (cd "${REPO_ROOT}/${dir}" && bun install)
done

# ---------------------------------------------------------------------------
# Link the global `vellum` command to this repo's meta package
# ---------------------------------------------------------------------------
info "Linking global 'vellum' command to meta/"
(cd "${REPO_ROOT}/meta" && bun link)

info "Setup complete! Run 'vellum --version' to verify."
