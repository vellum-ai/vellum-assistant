#!/bin/bash
# capture-live.sh — Record the screen and hand each chunk to the editor
#
# This script:
# 1. Records screen + audio in T-second segments via ffmpeg
# 2. Feeds each completed segment to editor.py, which transcribes dialogue,
#    picks story-critical frames, and decides when to wake the assistant
# 3. On stop, flushes any held window so the assistant sees the ending
#
# Usage: ./capture-live.sh <session_dir> <conversation_key> [chunk_seconds] [screen_device] [audio_device]
#
# conversation_key: the bare conversation UUID the assistant is watching from
#
# Requires: ffmpeg. Set GEMINI_API_KEY for editor verdicts — without it the
# assistant is woken on a fixed cadence with evenly spaced frames instead.

set -euo pipefail

SESSION_DIR="${1:?Usage: capture-live.sh <session_dir> <conversation_key> [chunk_seconds] [screen_device] [audio_device]}"
CONVERSATION_KEY="${2:?Missing conversation_key — the assistant needs to know where to send reactions}"
CHUNK_SECONDS="${3:-60}"
SCREEN_DEVICE="${4:-2}"
AUDIO_DEVICE="${5:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHUNKS_DIR="$SESSION_DIR/chunks"
VERDICTS_DIR="$SESSION_DIR/editor/verdicts"

# Clean previous recording data so the watcher doesn't skip stale chunks
rm -rf "$CHUNKS_DIR" "$SESSION_DIR/editor" "$SESSION_DIR/wakes" "$SESSION_DIR/editor-state.json"
mkdir -p "$CHUNKS_DIR" "$VERDICTS_DIR"

# Auto-detect audio device
if [[ -z "$AUDIO_DEVICE" ]]; then
    DEVICES=$(ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true)
    if echo "$DEVICES" | grep -qi "BlackHole"; then
        AUDIO_DEVICE=$(echo "$DEVICES" | grep -i "BlackHole" | head -1 | grep -o '\[[0-9]*\]' | tr -d '[]')
        echo "🔊 Audio: BlackHole (system audio capture)"
    else
        echo "⚠️  No BlackHole — video-only mode. Dialogue transcription will be empty."
        AUDIO_DEVICE="none"
    fi
fi

EDITOR_STATUS="${GEMINI_MODEL:-gemini-3-flash-preview}"
if [[ -z "${GEMINI_API_KEY:-}" ]]; then
    EDITOR_STATUS="disabled"
    echo "⚠️  GEMINI_API_KEY not set — editor disabled."
    echo "   The assistant will be woken every $((${WATCH_MAX_HOLD:-240} / 60)) min with evenly spaced frames."
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎬 Watch Together — Live Capture"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   Session:      $SESSION_DIR"
echo "   Conversation: ${CONVERSATION_KEY:0:40}..."
echo "   Chunks:       ${CHUNK_SECONDS}s each"
echo "   Audio:        $AUDIO_DEVICE"
echo "   Editor:       $EDITOR_STATUS"
echo ""
echo "   Press Ctrl+C to stop"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Background watcher: hand each fully written chunk to the editor.
# A chunk is considered fully written once ffprobe can read its moov atom;
# editor.py is idempotent per chunk (skips chunks it already has a verdict for).
watch_for_chunks() {
    while true; do
        local CHUNKS=()
        while IFS= read -r f; do
            CHUNKS+=("$f")
        done < <(ls "$CHUNKS_DIR"/chunk-*.mp4 2>/dev/null | sort)

        for CHUNK in "${CHUNKS[@]+"${CHUNKS[@]}"}"; do
            local CHUNK_NAME=$(basename "$CHUNK" .mp4)
            if [[ -f "$VERDICTS_DIR/$CHUNK_NAME.json" ]]; then
                continue
            fi
            if ! ffprobe -v error -show_entries format=duration "$CHUNK" >/dev/null 2>&1; then
                break
            fi
            python3 "$SCRIPT_DIR/editor.py" "$CHUNK" "$SESSION_DIR" "$CONVERSATION_KEY" "$CHUNK_SECONDS" || \
                echo "❌ Editor failed on $CHUNK_NAME (will not retry)"
        done

        sleep 3
    done
}

watch_for_chunks &
WATCHER_PID=$!

cleanup() {
    echo ""
    echo "🛑 Stopping capture..."
    kill $WATCHER_PID 2>/dev/null || true
    wait $WATCHER_PID 2>/dev/null || true

    # Process any chunk the watcher hadn't reached, then flush the held window
    local CHUNKS=($(ls "$CHUNKS_DIR"/chunk-*.mp4 2>/dev/null | sort))
    for CHUNK in "${CHUNKS[@]+"${CHUNKS[@]}"}"; do
        local CHUNK_NAME=$(basename "$CHUNK" .mp4)
        if [[ ! -f "$VERDICTS_DIR/$CHUNK_NAME.json" ]]; then
            python3 "$SCRIPT_DIR/editor.py" "$CHUNK" "$SESSION_DIR" "$CONVERSATION_KEY" "$CHUNK_SECONDS" || true
        fi
    done
    python3 "$SCRIPT_DIR/editor.py" --flush "$SESSION_DIR" "$CONVERSATION_KEY" "$CHUNK_SECONDS" || true

    echo ""
    echo "✅ Session complete!"
    echo "   Chunks: $CHUNKS_DIR"
    echo "   Wakes:  $SESSION_DIR/wakes"
}
trap cleanup EXIT INT TERM

# Build ffmpeg command
# Notes on macOS screen capture:
# - AVFoundation screen capture outputs uyvy422/nv12, not yuv420p
# - We let ffmpeg auto-select the input pixel format and convert during encoding
# - probesize helps with initial stream detection
# - r 30 on OUTPUT side controls encoding framerate (not capture)
FFMPEG_CMD=(ffmpeg -v warning -stats)
FFMPEG_CMD+=(-f avfoundation -capture_cursor 0 -probesize 20M -framerate 30)

if [[ "$AUDIO_DEVICE" == "none" ]]; then
    FFMPEG_CMD+=(-i "${SCREEN_DEVICE}:none")
else
    FFMPEG_CMD+=(-i "${SCREEN_DEVICE}:${AUDIO_DEVICE}")
fi

# Video: let x264 handle pixel format conversion internally
FFMPEG_CMD+=(-c:v libx264 -preset ultrafast -crf 28 -r 30)

if [[ "$AUDIO_DEVICE" != "none" ]]; then
    # Record at native 96kHz from BlackHole — resampling during live capture
    # drops audio frames. The editor's proxy encode handles the downsample.
    FFMPEG_CMD+=(-c:a aac -b:a 128k)
fi

FFMPEG_CMD+=(
    -f segment
    -segment_time "$CHUNK_SECONDS"
    -reset_timestamps 1
    -segment_format mp4
    "$CHUNKS_DIR/chunk-%03d.mp4"
)

echo "🔴 Recording... the editor will wake the assistant at the right moments"
echo ""
"${FFMPEG_CMD[@]}"
