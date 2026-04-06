#!/bin/bash
# capture.sh — Record screen + system audio in T-second chunks
# Usage: ./capture.sh <session_dir> [chunk_seconds] [screen_device] [audio_device]
#
# Prerequisites:
#   - ffmpeg installed (brew install ffmpeg)
#   - Screen recording permission granted
#   - For system audio: BlackHole installed (brew install blackhole-2ch)
#     Then set up a Multi-Output Device in Audio MIDI Setup that includes
#     both your speakers/headphones AND BlackHole 2ch
#
# The script records until you press 'q' or Ctrl+C.

set -euo pipefail

SESSION_DIR="${1:?Usage: capture.sh <session_dir> [chunk_seconds] [screen_device] [audio_device]}"
CHUNK_SECONDS="${2:-30}"
SCREEN_DEVICE="${3:-2}"  # "Capture screen 0" on most Macs
AUDIO_DEVICE="${4:-}"    # Auto-detect if not specified

# Auto-detect audio device: prefer BlackHole, fall back to mic
if [[ -z "$AUDIO_DEVICE" ]]; then
    DEVICES=$(ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true)
    if echo "$DEVICES" | grep -qi "BlackHole"; then
        AUDIO_DEVICE=$(echo "$DEVICES" | grep -i "BlackHole" | head -1 | grep -o '\[[0-9]*\]' | tr -d '[]')
        echo "🔊 Audio: BlackHole (system audio capture)"
    else
        echo "⚠️  BlackHole not found — no system audio capture available"
        echo "   Install with: brew install blackhole-2ch"
        echo "   Then set up Multi-Output Device in Audio MIDI Setup"
        echo ""
        echo "   Continuing WITHOUT audio capture (video-only mode)"
        echo "   The user will describe audio verbally 👂"
        AUDIO_DEVICE="none"
    fi
fi

CHUNKS_DIR="$SESSION_DIR/chunks"
mkdir -p "$CHUNKS_DIR"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎬 Watch Together — Capture"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   Session:  $SESSION_DIR"
echo "   Chunks:   ${CHUNK_SECONDS}s each"
echo "   Screen:   device $SCREEN_DEVICE"
echo "   Audio:    ${AUDIO_DEVICE}"
echo ""
echo "   Press 'q' to stop recording"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Build ffmpeg command
FFMPEG_CMD=(ffmpeg -v warning -stats)

# Input: screen
FFMPEG_CMD+=(-f avfoundation -capture_cursor 0 -framerate 30)

if [[ "$AUDIO_DEVICE" == "none" ]]; then
    FFMPEG_CMD+=(-i "${SCREEN_DEVICE}:none")
else
    FFMPEG_CMD+=(-i "${SCREEN_DEVICE}:${AUDIO_DEVICE}")
fi

# Video encoding: fast, reasonable quality
FFMPEG_CMD+=(-c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p)

# Audio encoding (if available)
if [[ "$AUDIO_DEVICE" != "none" ]]; then
    FFMPEG_CMD+=(-c:a aac -b:a 128k)
fi

# Segment into chunks
FFMPEG_CMD+=(
    -f segment
    -segment_time "$CHUNK_SECONDS"
    -reset_timestamps 1
    -segment_format mp4
    "$CHUNKS_DIR/chunk-%03d.mp4"
)

echo "🔴 Recording..."
"${FFMPEG_CMD[@]}"
echo ""
echo "✅ Recording stopped. Chunks saved to: $CHUNKS_DIR"
echo "   Process chunks with: ./process-chunk.sh <chunk.mp4> <output_dir>"
