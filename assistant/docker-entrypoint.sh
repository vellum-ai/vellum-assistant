#!/usr/bin/env sh
set -eu

if [ "$(id -u)" = "0" ] && [ "${VELLUM_WORKSPACE_DIR:-${WORKSPACE_DIR:-}}" = "/workspace" ] && [ -d /workspace ]; then
  git config --global --add safe.directory /workspace >/dev/null 2>&1 || true
  git config --global --add safe.directory '/workspace/*' >/dev/null 2>&1 || true
fi

exec bun run src/daemon/main.ts
