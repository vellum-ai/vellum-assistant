#!/usr/bin/env bash
# pack.sh — Build and package the Electron app for the target architecture.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: pack.sh [flags]

Build and package the Electron app for the target architecture.

Flags:
  --environment, --env <name>  Set VELLUM_ENVIRONMENT (default: local)
  --open                       Launch the built .app when done
  --help, -h                   Show this help

Environment:
  ELECTRON_TARGET_ARCH         arm64 | x64 (default: arm64)
EOF
}

OPEN_AFTER_BUILD=false
while [ $# -gt 0 ]; do
  case "$1" in
    --environment|--env)
      [ $# -ge 2 ] || { echo "ERROR: $1 requires a value" >&2; exit 1; }
      export VELLUM_ENVIRONMENT="$2"
      shift 2
      ;;
    --environment=*|--env=*)
      export VELLUM_ENVIRONMENT="${1#*=}"
      shift
      ;;
    --open)
      OPEN_AFTER_BUILD=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

export VELLUM_ENVIRONMENT="${VELLUM_ENVIRONMENT:-local}"

ARCH="${ELECTRON_TARGET_ARCH:-arm64}"
case "$ARCH" in
  arm64) BUN_ARCH=aarch64 ;;
  x64)   BUN_ARCH=x64 ;;
  *)
    echo "ERROR: unsupported ELECTRON_TARGET_ARCH: $ARCH (use arm64 or x64)" >&2
    exit 1
    ;;
esac

cd "$APP_DIR"

# Local builds run the repo CLI source at runtime (see getLocalCliEntry in
# src/main/cli-installer.ts); install its deps so the checkout is runnable.
if [ "$VELLUM_ENVIRONMENT" = "local" ]; then
  (cd "$APP_DIR/../../cli" && bun install)
fi

bash scripts/fetch-bun.sh --arch "$BUN_ARCH"
bash scripts/generate-icon.sh
bash scripts/build-mac-helper.sh
bun run build:web
bash scripts/generate-cli-lockfile.sh
electron-vite build
electron-builder --config electron-builder.config.cjs --publish always

if [ "$OPEN_AFTER_BUILD" = true ]; then
  # Newest .app wins — dist/ may hold stale apps from prior envs.
  APP_PATH="$(ls -dt "$APP_DIR"/dist/mac*/*.app 2>/dev/null | head -n 1 || true)"
  if [ -n "$APP_PATH" ]; then
    echo "Launching $APP_PATH"
    open "$APP_PATH"
  else
    echo "ERROR: no .app found under $APP_DIR/dist" >&2
    exit 1
  fi
fi
