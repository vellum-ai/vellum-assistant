#!/bin/bash
# process-session.sh — Process all chunks in a session directory
# Usage: ./process-session.sh <session_dir> [start_chunk]
#
# Processes each chunk through the frame extraction + audio pipeline.
# Can resume from a specific chunk number if interrupted.

set -euo pipefail

SESSION_DIR="${1:?Usage: process-session.sh <session_dir> [start_chunk]}"
START="${2:-0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

CHUNKS_DIR="$SESSION_DIR/chunks"
PROCESSED_DIR="$SESSION_DIR/processed"
mkdir -p "$PROCESSED_DIR"

# Find all chunks
CHUNKS=($(ls "$CHUNKS_DIR"/chunk-*.mp4 2>/dev/null | sort))
TOTAL=${#CHUNKS[@]}

if [[ $TOTAL -eq 0 ]]; then
    echo "❌ No chunks found in $CHUNKS_DIR"
    exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎬 Processing $TOTAL chunks (starting at $START)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

for i in $(seq "$START" $((TOTAL - 1))); do
    CHUNK="${CHUNKS[$i]}"
    CHUNK_NAME=$(basename "$CHUNK" .mp4)
    OUT="$PROCESSED_DIR/$CHUNK_NAME"

    if [[ -f "$OUT/manifest.json" ]]; then
        echo "⏭️  Skipping $CHUNK_NAME (already processed)"
        continue
    fi

    echo ""
    echo "[$((i+1))/$TOTAL] $CHUNK_NAME"
    "$SCRIPT_DIR/process-chunk.sh" "$CHUNK" "$OUT"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ All chunks processed!"
echo "   Processed data: $PROCESSED_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
