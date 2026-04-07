#!/bin/bash
# capture-live.sh — Record, process, and push chunks to the assistant in real time
#
# This script:
# 1. Records screen + audio in T-second segments
# 2. Automatically processes each segment (frame extraction + audio)
# 3. Sends a signal to the assistant's conversation so it sees each chunk
#
# Usage: ./capture-live.sh <session_dir> <conversation_key> [chunk_seconds] [screen_device] [audio_device]
#
# conversation_key: the conversation ID where the assistant is watching
#                   (e.g. "2026-03-30T06-08-25.628Z_191a7dcc-...")

set -euo pipefail

SESSION_DIR="${1:?Usage: capture-live.sh <session_dir> <conversation_key> [chunk_seconds] [screen_device] [audio_device]}"
CONVERSATION_KEY="${2:?Missing conversation_key — the assistant needs to know where to send reactions}"
CHUNK_SECONDS="${3:-30}"
SCREEN_DEVICE="${4:-2}"
AUDIO_DEVICE="${5:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SIGNALS_DIR="${VELLUM_WORKSPACE_DIR:-$HOME/.vellum/workspace}/signals"
CHUNKS_DIR="$SESSION_DIR/chunks"
PROCESSED_DIR="$SESSION_DIR/processed"

# Clean previous recording data so the watcher doesn't skip stale chunks
rm -rf "$CHUNKS_DIR" "$PROCESSED_DIR"
mkdir -p "$CHUNKS_DIR" "$PROCESSED_DIR" "$SIGNALS_DIR"

# Auto-detect audio device
if [[ -z "$AUDIO_DEVICE" ]]; then
    DEVICES=$(ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true)
    if echo "$DEVICES" | grep -qi "BlackHole"; then
        AUDIO_DEVICE=$(echo "$DEVICES" | grep -i "BlackHole" | head -1 | grep -o '\[[0-9]*\]' | tr -d '[]')
        echo "🔊 Audio: BlackHole (system audio capture)"
    else
        echo "⚠️  No BlackHole — video-only mode. The user will describe audio."
        AUDIO_DEVICE="none"
    fi
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎬 Watch Together — Live Capture"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   Session:      $SESSION_DIR"
echo "   Conversation: ${CONVERSATION_KEY:0:40}..."
echo "   Chunks:       ${CHUNK_SECONDS}s each"
echo "   Audio:        $AUDIO_DEVICE"
echo ""
echo "   Press Ctrl+C to stop"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Function to process a chunk and signal the assistant
process_and_signal() {
    local CHUNK_FILE="$1"
    local CHUNK_NAME=$(basename "$CHUNK_FILE" .mp4)
    local OUT_DIR="$PROCESSED_DIR/$CHUNK_NAME"

    echo "⚙️  Processing $CHUNK_NAME..."
    "$SCRIPT_DIR/process-chunk.sh" "$CHUNK_FILE" "$OUT_DIR" 2>&1

    if [[ ! -f "$OUT_DIR/manifest.json" ]]; then
        echo "❌ Processing failed for $CHUNK_NAME"
        return
    fi

    # Count frames
    local FRAME_COUNT=$(ls "$OUT_DIR/frames"/f_*.jpg 2>/dev/null | wc -l | tr -d ' ')
    local HAS_AUDIO="false"
    [[ -f "$OUT_DIR/audio/audio.mp3" ]] && HAS_AUDIO="true"

    # Build frame list (select ~6 evenly spaced frames for the assistant to look at)
    local FRAME_FILES=($(ls "$OUT_DIR/frames"/f_*.jpg 2>/dev/null | sort))
    local TOTAL_FRAMES=${#FRAME_FILES[@]}
    local SELECTED_FRAMES=""

    if [[ $TOTAL_FRAMES -le 6 ]]; then
        SELECTED_FRAMES=$(printf '%s\n' "${FRAME_FILES[@]}" | tr '\n' '|')
    else
        local STEP=$((TOTAL_FRAMES / 6))
        for i in 0 1 2 3 4 5; do
            local IDX=$((i * STEP))
            SELECTED_FRAMES+="${FRAME_FILES[$IDX]}|"
        done
    fi

    # Run Gemini audio analysis before building signal content
    if [[ -f "$OUT_DIR/audio/audio.mp3" ]] && [[ -n "${GEMINI_API_KEY:-}" ]]; then
        echo "🎧 Analyzing audio with Gemini..."

        # Build context-aware prompt with previous chunk's analysis
        local PROMPT_FILE=""
        local PREV_CHUNK_NUM=$((10#${CHUNK_NAME##*-} - 1))
        local PREV_ANALYSIS="$PROCESSED_DIR/$(printf "chunk-%03d" $PREV_CHUNK_NUM)/audio/gemini-analysis.json"
        if [[ $PREV_CHUNK_NUM -ge 0 ]] && [[ -f "$PREV_ANALYSIS" ]]; then
            PROMPT_FILE="$OUT_DIR/audio/prompt.txt"
            local PREV_TEXT
            PREV_TEXT=$(python3 -c "
import json
with open('$PREV_ANALYSIS') as f:
    print(json.load(f).get('audio_analysis', ''))
" 2>/dev/null || true)
            if [[ -n "$PREV_TEXT" ]]; then
                cat > "$PROMPT_FILE" << PROMPT_EOF
You are analyzing consecutive audio clips from the SAME source (a TV show or music video being watched in real time). Maintain consistency with your previous analysis unless the audio clearly contradicts it.

PREVIOUS CHUNK ANALYSIS:
$PREV_TEXT

---

Now analyze this next audio clip. Describe everything you hear:

1. **Dialogue**: Transcribe all spoken lines with approximate timestamps (e.g. [0:05]). For each line, describe the speaker's voice (pitch, age, quality) and delivery (tone, emotion, volume, pacing).

2. **Music**: Describe any music — mood, instruments, intensity, tempo, key feeling. How does it change across the clip? Note if there is NO music.

3. **Sound Design**: Non-speech, non-music audio. Ambient sounds, foley, environmental atmosphere.

4. **Emotional Arc**: How does the audio feel across the full duration? Where are the peaks and valleys?

5. **Silence & Pauses**: Note any significant silence or pauses.

Be specific and vivid. Describe what you hear as if translating sound for someone who cannot hear it.
PROMPT_EOF
            fi
        fi

        "$SCRIPT_DIR/analyze-audio.sh" "$OUT_DIR/audio/audio.mp3" "$OUT_DIR/audio/gemini-analysis.json" ${PROMPT_FILE:+"$PROMPT_FILE"} 2>&1 || echo "⚠️  Audio analysis failed (non-fatal)"
    fi

    # Read Gemini audio analysis if available (from a previous chunk's background run)
    local AUDIO_ANALYSIS=""
    if [[ -f "$OUT_DIR/audio/gemini-analysis.json" ]]; then
        AUDIO_ANALYSIS=$(python3 -c "
import json
with open('$OUT_DIR/audio/gemini-analysis.json') as f:
    data = json.loads(f.read())
print(data.get('audio_analysis', 'No analysis available'))
" 2>/dev/null || echo "Could not read audio analysis")
    fi

    # Read volume info
    local VOLUME_INFO=""
    if [[ -f "$OUT_DIR/audio/volume.txt" ]] && [[ -s "$OUT_DIR/audio/volume.txt" ]]; then
        VOLUME_INFO=$(cat "$OUT_DIR/audio/volume.txt")
    fi

    # Build content with all info embedded
    local CONTENT="[WATCH-CHUNK] ${CHUNK_NAME}
Session: ${SESSION_DIR}
Processed: ${OUT_DIR}
Frames: ${FRAME_COUNT} total, 6 key frames attached

Spectrogram: ${OUT_DIR}/audio/spectrogram.png
Raw chunk: ${CHUNKS_DIR}/${CHUNK_NAME}.mp4"

    if [[ -n "$AUDIO_ANALYSIS" ]]; then
        CONTENT="${CONTENT}

🎧 AUDIO ANALYSIS (Gemini):
${AUDIO_ANALYSIS}"
    fi

    if [[ -n "$VOLUME_INFO" ]]; then
        CONTENT="${CONTENT}

📊 Volume: ${VOLUME_INFO}"
    fi

    CONTENT="${CONTENT}

The key frames are attached as images — you can see them directly. The audio analysis above describes what was heard. React, update episode-state.md, enjoy the show. 🔔"

    # Write signal to wake the assistant
    local REQUEST_ID="watch-${CHUNK_NAME}-$(date +%s)"
    local SIGNAL_FILE="$SIGNALS_DIR/user-message.${REQUEST_ID}"

    SIG_CONTENT="$CONTENT" \
    SIG_FRAMES="$SELECTED_FRAMES" \
    SIG_OUT_DIR="$OUT_DIR" \
    SIG_CONV_KEY="$CONVERSATION_KEY" \
    SIG_REQ_ID="$REQUEST_ID" \
    SIG_FILE="$SIGNAL_FILE" \
    python3 << 'PYEOF'
import json, os

content = os.environ["SIG_CONTENT"]
selected_frames = os.environ["SIG_FRAMES"]
out_dir = os.environ["SIG_OUT_DIR"]
conversation_key = os.environ["SIG_CONV_KEY"]
request_id = os.environ["SIG_REQ_ID"]
signal_file = os.environ["SIG_FILE"]

# Build attachments from selected frames
attachments = []
for f in selected_frames.rstrip("|").split("|"):
    f = f.strip()
    if f and os.path.isfile(f):
        attachments.append({
            "path": f,
            "filename": os.path.basename(f),
            "mimeType": "image/jpeg"
        })

# Attach spectrogram if it exists
spec = os.path.join(out_dir, "audio", "spectrogram.png")
if os.path.isfile(spec):
    attachments.append({
        "path": spec,
        "filename": "spectrogram.png",
        "mimeType": "image/png"
    })

signal = {
    "conversationKey": conversation_key,
    "content": content,
    "sourceChannel": "vellum",
    "interface": "cli",
    "requestId": request_id,
    "bypassSecretCheck": True,
    "attachments": attachments
}
with open(signal_file, "w") as f:
    json.dump(signal, f)
PYEOF

    echo "📨 Signaled assistant: $CHUNK_NAME ($FRAME_COUNT frames, audio: $HAS_AUDIO)"
}

# Background watcher: process new chunks as they appear
# Strategy: process chunk N when chunk N+1 appears (proves N is fully written)
watch_for_chunks() {
    local LAST_PROCESSED=-1

    while true; do
        # Glob may match nothing; disable nounset temporarily for safe array building
        local CHUNKS=()
        while IFS= read -r f; do
            CHUNKS+=("$f")
        done < <(ls "$CHUNKS_DIR"/chunk-*.mp4 2>/dev/null | sort)
        local CURRENT_COUNT=${#CHUNKS[@]}

        local idx=$((LAST_PROCESSED + 1))
        while [[ $idx -lt $CURRENT_COUNT ]]; do
            local CHUNK="${CHUNKS[$idx]}"
            local CHUNK_NAME=$(basename "$CHUNK" .mp4)

            # Skip if already processed
            if [[ -f "$PROCESSED_DIR/$CHUNK_NAME/manifest.json" ]]; then
                LAST_PROCESSED=$idx
                idx=$((idx + 1))
                continue
            fi

            # Only process if the file has a valid moov atom (fully written)
            if ! ffprobe -v error -show_entries format=duration "$CHUNK" >/dev/null 2>&1; then
                break
            fi

            process_and_signal "$CHUNK"
            LAST_PROCESSED=$idx
            idx=$((idx + 1))
        done

        sleep 3
    done
}

# Start the chunk watcher in the background
watch_for_chunks &
WATCHER_PID=$!

# Cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping capture..."
    kill $WATCHER_PID 2>/dev/null || true
    wait $WATCHER_PID 2>/dev/null || true

    # Process any remaining unprocessed chunks
    echo "⚙️  Processing remaining chunks..."
    local CHUNKS=($(ls "$CHUNKS_DIR"/chunk-*.mp4 2>/dev/null | sort))
    for CHUNK in "${CHUNKS[@]}"; do
        local CHUNK_NAME=$(basename "$CHUNK" .mp4)
        if [[ ! -f "$PROCESSED_DIR/$CHUNK_NAME/manifest.json" ]]; then
            process_and_signal "$CHUNK"
        fi
    done

    echo ""
    echo "✅ Session complete!"
    echo "   Chunks: $CHUNKS_DIR"
    echo "   Processed: $PROCESSED_DIR"
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
    # drops audio frames. Extraction in process-chunk.sh handles the downsample.
    FFMPEG_CMD+=(-c:a aac -b:a 128k)
fi

FFMPEG_CMD+=(
    -f segment
    -segment_time "$CHUNK_SECONDS"
    -reset_timestamps 1
    -segment_format mp4
    "$CHUNKS_DIR/chunk-%03d.mp4"
)

echo "🔴 Recording... chunks will be sent to the assistant automatically"
echo ""
"${FFMPEG_CMD[@]}"
