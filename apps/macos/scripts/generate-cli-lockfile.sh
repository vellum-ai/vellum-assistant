#!/usr/bin/env bash
# generate-cli-lockfile.sh — Resolve the CLI dependency graph at build time
# and ship it as an app resource so the runtime install uses
# `bun install --frozen-lockfile` instead of resolving from the live registry.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/.."
SEED_DIR="$APP_DIR/resources/cli-lockfile"

VERSION=$(grep -o 'PINNED_CLI_VERSION = "[^"]*"' "$APP_DIR/src/main/cli-installer.ts" \
  | sed 's/PINNED_CLI_VERSION = "//;s/"//')

if [ -z "$VERSION" ]; then
  echo "ERROR: could not read PINNED_CLI_VERSION from cli-installer.ts" >&2
  exit 1
fi

# Local builds drive the repo CLI source directly (see getLocalCliEntry in
# cli-installer.ts) and never install from npm. Ship an empty seed dir so
# electron-builder's extraResources mapping still resolves.
if [ "${VELLUM_ENVIRONMENT:-local}" = "local" ]; then
  echo "Local build: skipping CLI lockfile (app runs the repo CLI source)"
  rm -rf "$SEED_DIR"
  mkdir -p "$SEED_DIR"
  exit 0
fi

echo "Generating CLI lockfile for vellum@$VERSION ..."

rm -rf "$SEED_DIR"
mkdir -p "$SEED_DIR"

cat > "$SEED_DIR/package.json" <<EOF
{"dependencies":{"vellum":"$VERSION"}}
EOF

(cd "$SEED_DIR" && bun install --ignore-scripts)

if [ ! -f "$SEED_DIR/bun.lock" ]; then
  echo "ERROR: bun.lock was not generated" >&2
  exit 1
fi

# Only ship the seed files; node_modules is discarded.
rm -rf "$SEED_DIR/node_modules"

echo "CLI lockfile generated at $SEED_DIR"
