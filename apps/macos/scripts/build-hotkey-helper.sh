#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$ROOT_DIR/native/hotkey-helper"
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

mkdir -p "$OUTPUT_DIR"
xcrun swift build --package-path "$PACKAGE_DIR" -c release
cp "$PACKAGE_DIR/.build/release/hotkey-helper" "$OUTPUT"
chmod 755 "$OUTPUT"
