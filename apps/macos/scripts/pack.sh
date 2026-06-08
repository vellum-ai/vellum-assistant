#!/usr/bin/env bash
# pack.sh — Build and package the Electron app for the target architecture.
#
# Reads ELECTRON_TARGET_ARCH (arm64 | x64, default arm64) and maps it to
# the correct --arch value for fetch-bun.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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

bash scripts/fetch-bun.sh --arch "$BUN_ARCH"
bash scripts/generate-icon.sh
bash scripts/build-mac-helper.sh
bun run build:web
bash scripts/generate-cli-lockfile.sh
electron-vite build
electron-builder --config electron-builder.config.cjs
