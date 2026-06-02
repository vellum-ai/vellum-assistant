#!/usr/bin/env bash
# fetch-bun.sh — Download the bun binary pinned in .tool-versions into
# apps/macos/resources/bun for bundling via electron-builder.
#
# Mirrors the pattern in clients/macos/build.sh (fetch_bundled_bun).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/../resources"

# Parse bun version from the repo-root .tool-versions
TOOL_VERSIONS="$SCRIPT_DIR/../../../.tool-versions"
BUN_VERSION=$(awk '$1 == "bun" { print $2 }' "$TOOL_VERSIONS" 2>/dev/null)
if [ -z "$BUN_VERSION" ]; then
  echo "ERROR: could not read bun version from $TOOL_VERSIONS" >&2
  exit 1
fi

# If the binary already exists and matches the expected version, skip download
if [ -x "$RESOURCES_DIR/bun" ]; then
  CURRENT_VERSION=$("$RESOURCES_DIR/bun" --version 2>/dev/null || echo "")
  if [ "$CURRENT_VERSION" = "$BUN_VERSION" ]; then
    echo "bun $BUN_VERSION already present at $RESOURCES_DIR/bun — skipping download."
    exit 0
  fi
fi

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64)
    PLATFORM="darwin-aarch64"
    ;;
  x86_64)
    PLATFORM="darwin-x64"
    ;;
  *)
    echo "ERROR: unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${PLATFORM}.zip"
echo "Downloading bun ${BUN_VERSION} (${PLATFORM})..."

TMPDIR_DL=$(mktemp -d)
trap 'rm -rf "$TMPDIR_DL"' EXIT

ZIP_PATH="$TMPDIR_DL/bun.zip"
if ! curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 30 \
        --output "$ZIP_PATH" "$URL"; then
  echo "ERROR: failed to download bun binary from $URL" >&2
  exit 1
fi

if ! unzip -o -q "$ZIP_PATH" -d "$TMPDIR_DL"; then
  echo "ERROR: failed to extract bun zip" >&2
  exit 1
fi

EXTRACTED="$TMPDIR_DL/bun-${PLATFORM}/bun"
if [ ! -f "$EXTRACTED" ]; then
  echo "ERROR: bun binary missing after extraction at $EXTRACTED" >&2
  exit 1
fi

mkdir -p "$RESOURCES_DIR"
cp "$EXTRACTED" "$RESOURCES_DIR/bun"
chmod +x "$RESOURCES_DIR/bun"

echo "bun ${BUN_VERSION} installed to $RESOURCES_DIR/bun"
