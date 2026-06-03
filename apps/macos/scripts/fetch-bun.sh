#!/usr/bin/env bash
# fetch-bun.sh — Download the bun binary pinned in .tool-versions into
# apps/macos/resources/bun for bundling via electron-builder.
#
# Mirrors the pattern in clients/macos/build.sh (fetch_bundled_bun).
#
# Usage:
#   bash scripts/fetch-bun.sh [--arch <aarch64|x64|universal>]
#
# When --arch is omitted the script detects from `uname -m` (suitable for
# local dev where host == target). CI should pass --arch explicitly to avoid
# shipping the wrong binary when building x64 on ARM runners (or vice versa).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/../resources"
CHECKSUMS_FILE="$SCRIPT_DIR/bun-checksums.sha256"

# Parse bun version from the repo-root .tool-versions
TOOL_VERSIONS="$SCRIPT_DIR/../../../.tool-versions"
BUN_VERSION=$(awk '$1 == "bun" { print $2 }' "$TOOL_VERSIONS" 2>/dev/null)
if [ -z "$BUN_VERSION" ]; then
  echo "ERROR: could not read bun version from $TOOL_VERSIONS" >&2
  exit 1
fi

# --- Argument parsing ---
TARGET_ARCH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      TARGET_ARCH="$2"
      shift 2
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      echo "Usage: fetch-bun.sh [--arch <aarch64|x64|universal>]" >&2
      exit 1
      ;;
  esac
done

# Default to host architecture when --arch is not specified
if [ -z "$TARGET_ARCH" ]; then
  HOST_ARCH=$(uname -m)
  case "$HOST_ARCH" in
    aarch64|arm64) TARGET_ARCH="aarch64" ;;
    x86_64)        TARGET_ARCH="x64" ;;
    *)
      echo "ERROR: unsupported host architecture: $HOST_ARCH" >&2
      exit 1
      ;;
  esac
fi

# --- Helper functions ---

verify_checksum() {
  local zip_path="$1"
  local platform="$2"

  if [ ! -f "$CHECKSUMS_FILE" ]; then
    echo "WARNING: checksums file not found at $CHECKSUMS_FILE — skipping verification" >&2
    return 0
  fi

  local expected
  expected=$(grep "bun-${platform}.zip" "$CHECKSUMS_FILE" | awk '{ print $1 }')
  if [ -z "$expected" ]; then
    echo "WARNING: no checksum entry for bun-${platform}.zip — skipping verification" >&2
    return 0
  fi

  local actual
  actual=$(shasum -a 256 "$zip_path" | awk '{ print $1 }')
  if [ "$actual" != "$expected" ]; then
    echo "ERROR: checksum mismatch for bun-${platform}.zip" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
  echo "Checksum verified for bun-${platform}.zip"
}

fetch_single_bun() {
  local platform="$1"
  local dest="$2"

  local url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${platform}.zip"
  echo "Downloading bun ${BUN_VERSION} (${platform})..."

  local tmpdir
  tmpdir=$(mktemp -d)

  local zip_path="$tmpdir/bun.zip"
  if ! curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 30 \
          --output "$zip_path" "$url"; then
    echo "ERROR: failed to download bun binary from $url" >&2
    rm -rf "$tmpdir"
    exit 1
  fi

  verify_checksum "$zip_path" "$platform"

  if ! unzip -o -q "$zip_path" -d "$tmpdir"; then
    echo "ERROR: failed to extract bun zip" >&2
    rm -rf "$tmpdir"
    exit 1
  fi

  local extracted="$tmpdir/bun-${platform}/bun"
  if [ ! -f "$extracted" ]; then
    echo "ERROR: bun binary missing after extraction at $extracted" >&2
    rm -rf "$tmpdir"
    exit 1
  fi

  mkdir -p "$(dirname "$dest")"
  cp "$extracted" "$dest"
  chmod +x "$dest"
  rm -rf "$tmpdir"
}

# --- Main ---

DEST="$RESOURCES_DIR/bun"

# For non-universal builds, check if existing binary matches version AND architecture
if [ "$TARGET_ARCH" != "universal" ] && [ -x "$DEST" ]; then
  CURRENT_VERSION=$("$DEST" --version 2>/dev/null || echo "")
  if [ "$CURRENT_VERSION" = "$BUN_VERSION" ]; then
    CURRENT_ARCHS=$(lipo -archs "$DEST" 2>/dev/null || echo "")
    case "$TARGET_ARCH" in
      aarch64) EXPECTED_ARCH="arm64" ;;
      x64)     EXPECTED_ARCH="x86_64" ;;
    esac
    if [ "$CURRENT_ARCHS" = "$EXPECTED_ARCH" ]; then
      echo "bun $BUN_VERSION ($TARGET_ARCH) already present at $DEST — skipping download."
      exit 0
    fi
    echo "bun $BUN_VERSION present but wrong arch (have $CURRENT_ARCHS, need $EXPECTED_ARCH) — re-fetching."
  fi
fi

mkdir -p "$RESOURCES_DIR"

case "$TARGET_ARCH" in
  aarch64)
    fetch_single_bun "darwin-aarch64" "$DEST"
    ;;
  x64)
    fetch_single_bun "darwin-x64" "$DEST"
    ;;
  universal)
    # Download both architectures and combine via lipo (fat Mach-O)
    TMPDIR_LIPO=$(mktemp -d)
    trap 'rm -rf "$TMPDIR_LIPO"' EXIT

    fetch_single_bun "darwin-aarch64" "$TMPDIR_LIPO/bun-arm64"
    fetch_single_bun "darwin-x64" "$TMPDIR_LIPO/bun-x64"

    echo "Creating universal binary via lipo..."
    if ! lipo -create "$TMPDIR_LIPO/bun-arm64" "$TMPDIR_LIPO/bun-x64" -output "$DEST"; then
      echo "ERROR: lipo failed to create universal bun binary" >&2
      exit 1
    fi
    chmod +x "$DEST"
    ;;
  *)
    echo "ERROR: unsupported target arch: $TARGET_ARCH (use aarch64|x64|universal)" >&2
    exit 1
    ;;
esac

echo "bun ${BUN_VERSION} (${TARGET_ARCH}) installed to $DEST"
