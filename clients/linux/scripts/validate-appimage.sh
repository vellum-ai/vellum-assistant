#!/usr/bin/env bash
# validate-appimage.sh — Assert the pack produced a structurally valid AppImage.
# Checks the newest dist/*.AppImage: exists, executable, and carries the
# AppImage type-2 magic bytes (0x41 0x49 0x02 at offset 8) so a stray ELF or a
# truncated file can't pass as a release artifact.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$SCRIPT_DIR/../dist"

APP="$(ls -dt "$DIST_DIR"/*.AppImage 2>/dev/null | head -n1 || true)"
if [ -z "$APP" ] || [ ! -f "$APP" ]; then
  echo "::error::No .AppImage found in $DIST_DIR" >&2
  ls -la "$DIST_DIR" 2>/dev/null || true
  exit 1
fi

[ -x "$APP" ] || { echo "::error::AppImage is not executable: $APP" >&2; exit 1; }

MAGIC="$(dd if="$APP" bs=1 skip=8 count=3 2>/dev/null | od -An -tx1 | tr -d ' \n')"
if [ "$MAGIC" != "414902" ]; then
  echo "::error::Not a valid AppImage (type-2 magic 0x414902 expected, got 0x$MAGIC): $APP" >&2
  exit 1
fi

echo "Valid AppImage: $APP ($(du -h "$APP" | cut -f1))"
