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

ARCH="${ELECTRON_TARGET_ARCH:-}"
if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    arm64)  ARCH=arm64 ;;
    x86_64) ARCH=x64 ;;
    *)
      echo "build-notifier: unsupported host architecture $(uname -m)" >&2
      exit 1
      ;;
  esac
fi

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

OUTPUT_DIR="$ROOT_DIR/resources/notifier/$ARCH"
mkdir -p "$OUTPUT_DIR"
cp "$BUILT" "$OUTPUT_DIR/vellum-notifier.node"
echo "build-notifier: wrote $OUTPUT_DIR/vellum-notifier.node"
