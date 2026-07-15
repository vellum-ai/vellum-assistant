#!/bin/bash
# rewind.sh — Dense 720p frame extraction for a time range of a chunk
# Usage: ./rewind.sh <chunk.mp4> <output_dir> <start_seconds> <end_seconds>
#
# Use when something in a wake catches the assistant's eye and the attached
# frames aren't enough — pulls 10fps frames for the requested range.

set -euo pipefail

CHUNK="${1:?Usage: rewind.sh <chunk.mp4> <output_dir> <start_seconds> <end_seconds>}"
OUTPUT_DIR="${2:?Missing output_dir}"
START="${3:?Missing start_seconds}"
END="${4:?Missing end_seconds}"

REWIND_DIR="$OUTPUT_DIR/rewind_${START}_${END}"
mkdir -p "$REWIND_DIR"

echo "🔍 Rewind: pulling 10fps from ${START}s to ${END}s"
ffmpeg -v warning -ss "$START" -to "$END" -i "$CHUNK" \
    -vf "scale=-2:720" \
    -r 10 \
    -q:v 2 \
    "$REWIND_DIR/r_%04d.jpg"

RCOUNT=$(ls "$REWIND_DIR"/r_*.jpg 2>/dev/null | wc -l | tr -d ' ')
echo "✅ Rewind complete: $RCOUNT frames at 720p in $REWIND_DIR"
