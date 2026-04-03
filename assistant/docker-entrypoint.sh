#!/usr/bin/env sh
set -eu

if [ "$(id -u)" = "0" ] && [ "${VELLUM_WORKSPACE_DIR:-}" = "/workspace" ] && [ -d /workspace ]; then
  git config --global --add safe.directory /workspace >/dev/null 2>&1 || true
  git config --global --add safe.directory '/workspace/*' >/dev/null 2>&1 || true
fi

export BUN_CONFIG_FILE="/app/assistant/smol-bunfig.toml"

exec bun run src/daemon/main.ts
