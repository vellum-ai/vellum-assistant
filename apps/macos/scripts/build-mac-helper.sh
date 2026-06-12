#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$ROOT_DIR/native/mac-helper"
OUTPUT_DIR="$ROOT_DIR/resources"
OUTPUT_BUNDLE="$OUTPUT_DIR/vellum-mac-helper.app"
OUTPUT="$OUTPUT_BUNDLE/Contents/MacOS/vellum-mac-helper"
OUTPUT_INFO_PLIST="$OUTPUT_BUNDLE/Contents/Info.plist"
INFO_PLIST="$PACKAGE_DIR/Sources/MacHelperExecutable/Info.plist"

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
# Legacy layouts (bare binary / old name) — always clear.
rm -f "$OUTPUT_DIR/hotkey-helper" "$OUTPUT_DIR/vellum-mac-helper" "$OUTPUT_DIR/Info.plist"
xcrun swift build "${BUILD_ARGS[@]}"
BUILD_DIR="$(xcrun swift build "${BUILD_ARGS[@]}" --show-bin-path)"

# Skip the install when the build output is unchanged: replacing and
# re-signing churns nothing semantically, but a fresh bundle invalidates
# the CDHash that TCC keys the helper's mic/speech grants on, so every
# no-op rebuild (e.g. `bun run dev`'s postinstall) would re-prompt. The
# signed binary never byte-matches the unsigned build output, so compare
# against a hash marker of the inputs recorded at install time.
SOURCE_HASH="$(cat "$BUILD_DIR/vellum-mac-helper" "$INFO_PLIST" "$ROOT_DIR/scripts/entitlements/helper.plist" | shasum -a 256 | cut -d' ' -f1)"
HASH_MARKER="$OUTPUT_DIR/.vellum-mac-helper.source-hash"
if [ -x "$OUTPUT" ] && [ -f "$HASH_MARKER" ] && [ "$(cat "$HASH_MARKER")" = "$SOURCE_HASH" ]; then
  echo "build-mac-helper: bundle unchanged; keeping existing copy"
else
  # Remove before installing: overwriting a signed Mach-O in place reuses
  # the inode, and the kernel's stale signature cache SIGKILLs the next
  # spawn (exit 137). A fresh bundle sidesteps it.
  rm -rf "$OUTPUT_BUNDLE"
  mkdir -p "$OUTPUT_BUNDLE/Contents/MacOS"
  cp "$BUILD_DIR/vellum-mac-helper" "$OUTPUT"
  cp "$INFO_PLIST" "$OUTPUT_INFO_PLIST"
  chmod 755 "$OUTPUT"
  codesign --force --sign - --entitlements "$ROOT_DIR/scripts/entitlements/helper.plist" "$OUTPUT_BUNDLE"
  printf '%s' "$SOURCE_HASH" > "$HASH_MARKER"
fi
