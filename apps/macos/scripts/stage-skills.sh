#!/usr/bin/env bash
# stage-skills.sh -- Copy the first-party skills catalog into
# apps/macos/resources/first-party-skills/ for bundling via
# electron-builder. Mirrors the rsync in clients/macos/build.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/../../.."
SKILLS_SRC="$REPO_ROOT/skills"
DEST="$SCRIPT_DIR/../resources/first-party-skills"

if [ ! -d "$SKILLS_SRC" ]; then
  echo "ERROR: skills directory not found at $SKILLS_SRC" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"

rsync -a \
  --exclude='node_modules/' \
  --exclude='*.tsbuildinfo' \
  --exclude='dist/' \
  --exclude='build/' \
  --exclude='.git/' \
  --exclude='__tests__/' \
  --exclude='meet-join/bot/' \
  --exclude='meet-join/meet-controller-ext/' \
  "$SKILLS_SRC/" "$DEST/"

# Emit meet-join manifest (matches emit_meet_join_manifest() in build.sh)
EMIT_SCRIPT="$SKILLS_SRC/meet-join/scripts/emit-manifest.ts"
if [ -f "$EMIT_SCRIPT" ]; then
  if command -v bun &>/dev/null; then
    mkdir -p "$DEST/meet-join"
    (cd "$SKILLS_SRC/meet-join" && bun run scripts/emit-manifest.ts \
      --output "$DEST/meet-join/manifest.json")
  else
    echo "WARNING: bun not on PATH -- skipping meet-join manifest emission" >&2
  fi
fi

echo "Staged first-party skills: $(du -sh "$DEST" | cut -f1)"
