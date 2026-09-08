#!/usr/bin/env bash
# build-notifier.sh: build the native notifier addon into resources/notifier.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$ROOT_DIR/native/notifier"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-notifier: skipping non-macOS host"
  exit 0
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "build-notifier: xcrun not found; install Xcode command line tools" >&2
  exit 1
fi

# The packaged app's architecture comes from ELECTRON_TARGET_ARCH, defaulting
# to arm64 in pack.sh and electron-builder.config.cjs. The addon follows the
# same variable rather than the host's architecture: electron-builder packs
# whatever is under resources/notifier, so a host-shaped addon in an arm64 pack
# ships an app that quietly falls back to plain notifications.
# `lipo -archs` names the x64 slice x86_64.
ARCH="${ELECTRON_TARGET_ARCH:-arm64}"
case "$ARCH" in
  arm64) EXPECTED_SLICE=arm64 ;;
  x64)   EXPECTED_SLICE=x86_64 ;;
  *)
    echo "build-notifier: unsupported ELECTRON_TARGET_ARCH: $ARCH (use arm64 or x64)" >&2
    exit 1
    ;;
esac

# The addon links against Electron's V8/Node ABI, so it is compiled against the
# headers for the exact Electron the app ships with.
ELECTRON_VERSION="$(node -p "require('$ROOT_DIR/package.json').devDependencies.electron")"
if [ -z "$ELECTRON_VERSION" ] || [ "$ELECTRON_VERSION" = "undefined" ]; then
  echo "build-notifier: could not read the electron version from package.json" >&2
  exit 1
fi

NODE_GYP_BIN="$(cd "$PACKAGE_DIR" && node -e "process.stdout.write(require.resolve('node-gyp/bin/node-gyp.js'))" 2>/dev/null || true)"
if [ -z "$NODE_GYP_BIN" ]; then
  echo "build-notifier: node-gyp not found; run bun install in clients/macos" >&2
  exit 1
fi

cd "$PACKAGE_DIR"
node "$NODE_GYP_BIN" rebuild \
  --target="$ELECTRON_VERSION" \
  --arch="$ARCH" \
  --dist-url=https://electronjs.org/headers \
  --devdir="${HOME}/.electron-gyp"

BUILT="$PACKAGE_DIR/build/Release/vellum_notifier.node"
if [ ! -f "$BUILT" ]; then
  echo "build-notifier: node-gyp produced no addon at $BUILT" >&2
  exit 1
fi

# One build produces one architecture, and electron-builder packs whatever is
# under resources/notifier, so a previous build for another arch is cleared
# rather than shipped alongside this one.
rm -rf "$ROOT_DIR/resources/notifier"
OUTPUT_DIR="$ROOT_DIR/resources/notifier/$ARCH"
mkdir -p "$OUTPUT_DIR"
OUTPUT="$OUTPUT_DIR/vellum-notifier.node"
cp "$BUILT" "$OUTPUT"

# A toolchain that ignores --arch produces a host-architecture binary, and
# electron-builder signs and packs whatever it finds, so the mismatch has to
# fail here rather than at the user's first notification.
SLICES="$(lipo -archs "$OUTPUT")"
case " $SLICES " in
  *" $EXPECTED_SLICE "*) ;;
  *)
    echo "build-notifier: $OUTPUT is built for $SLICES, not $EXPECTED_SLICE ($ARCH)" >&2
    exit 1
    ;;
esac

echo "build-notifier: wrote $OUTPUT ($SLICES)"
