#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$ROOT_DIR/native/mac-helper"
OUTPUT_DIR="$ROOT_DIR/resources"
OUTPUT="$OUTPUT_DIR/vellum-mac-helper"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-mac-helper: skipping non-macOS host"
  exit 0
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "build-mac-helper: xcrun not found; install Xcode command line tools" >&2
  exit 1
fi

BUILD_ARGS=(--package-path "$PACKAGE_DIR" -c release)
if [ -n "${ELECTRON_TARGET_ARCH:-}" ]; then
  case "$ELECTRON_TARGET_ARCH" in
    arm64) BUILD_ARGS+=(--triple arm64-apple-macosx15.0) ;;
    x64)   BUILD_ARGS+=(--triple x86_64-apple-macosx15.0) ;;
  esac
fi

# Embed Info.plist (bundle id + microphone / speech-recognition usage
# strings) into the bare executable so TCC can attribute permission
# prompts for the dictation-partials session without a full .app bundle.
INFO_PLIST="$PACKAGE_DIR/Sources/MacHelperExecutable/Info.plist"
BUILD_ARGS+=(
  -Xlinker -sectcreate
  -Xlinker __TEXT
  -Xlinker __info_plist
  -Xlinker "$INFO_PLIST"
)

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_DIR/hotkey-helper"
xcrun swift build "${BUILD_ARGS[@]}"
BUILD_DIR="$(xcrun swift build "${BUILD_ARGS[@]}" --show-bin-path)"
# Skip the copy when the binary is byte-identical: replacing it churns the
# ad-hoc CDHash that TCC keys the helper's mic/speech grants on, so every
# no-op rebuild (e.g. `bun run dev`'s postinstall) would re-prompt.
if cmp -s "$BUILD_DIR/vellum-mac-helper" "$OUTPUT"; then
  echo "build-mac-helper: binary unchanged; keeping existing copy"
else
  # Remove before copying: overwriting a signed Mach-O in place reuses the
  # inode, and the kernel's stale signature cache SIGKILLs the next spawn
  # (exit 137). A fresh inode sidesteps it.
  rm -f "$OUTPUT"
  cp "$BUILD_DIR/vellum-mac-helper" "$OUTPUT"
  chmod 755 "$OUTPUT"
fi
