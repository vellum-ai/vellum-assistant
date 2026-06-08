#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT_DIR/native/hotkey-helper/main.swift"
OUTPUT_DIR="$ROOT_DIR/resources"
OUTPUT="$OUTPUT_DIR/hotkey-helper"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-hotkey-helper: skipping non-macOS host"
  exit 0
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "build-hotkey-helper: xcrun not found; install Xcode command line tools" >&2
  exit 1
fi

TARGET_FLAGS=""
if [ -n "${ELECTRON_TARGET_ARCH:-}" ]; then
  case "$ELECTRON_TARGET_ARCH" in
    arm64) TARGET_FLAGS="-target arm64-apple-macosx15.0" ;;
    x64)   TARGET_FLAGS="-target x86_64-apple-macosx15.0" ;;
  esac
fi

mkdir -p "$OUTPUT_DIR"
xcrun swiftc $TARGET_FLAGS "$SOURCE" -framework AppKit -framework Carbon -o "$OUTPUT"
chmod 755 "$OUTPUT"
