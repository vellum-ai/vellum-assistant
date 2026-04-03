#!/bin/bash
# process-chunk.sh — Extract frames + audio from a video chunk
# Usage: ./process-chunk.sh <chunk.mp4> <output_dir> [--rewind START END]

set -euo pipefail

CHUNK="$1"
OUTPUT_DIR="$2"
SHORT_EDGE="${SHORT_EDGE:-480}"
SCENE_THRESHOLD="${SCENE_THRESHOLD:-0.3}"
FPS=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$CHUNK" | head -1)
# Convert fractional fps (e.g. "30000/1001") to integer
FPS_INT=$(python3 -c "print(int(round(eval('$FPS'))))")

mkdir -p "$OUTPUT_DIR/frames" "$OUTPUT_DIR/audio"

# --- REWIND MODE: dense extraction for a specific time range ---
if [[ "${3:-}" == "--rewind" ]]; then
    START="${4:?rewind needs START time}"
    END="${5:?rewind needs END time}"
    REWIND_DIR="$OUTPUT_DIR/rewind_${START}_${END}"
    mkdir -p "$REWIND_DIR"

    echo "🔍 Rewind mode: pulling 10fps from ${START}s to ${END}s"
    ffmpeg -v warning -ss "$START" -to "$END" -i "$CHUNK" \
        -vf "scale=-1:720" \
        -r 10 \
        -q:v 2 \
        "$REWIND_DIR/r_%04d.jpg"

    # Count output frames
    RCOUNT=$(ls "$REWIND_DIR"/r_*.jpg 2>/dev/null | wc -l | tr -d ' ')
    echo "✅ Rewind complete: $RCOUNT frames at 720p"
    exit 0
fi

# --- NORMAL MODE: scene detection + 1fps baseline ---
echo "🎬 Processing: $(basename "$CHUNK")"
echo "   FPS: $FPS_INT | Scene threshold: $SCENE_THRESHOLD | Scale: ${SHORT_EDGE}p"

# Extract frames: 1fps baseline + scene change detection
# Pipe showinfo to capture timestamps for each output frame
# Extract frames — showinfo goes to stderr, frames to files
ffmpeg -v warning -i "$CHUNK" \
    -vf "scale=-1:${SHORT_EDGE},select='not(mod(n\,${FPS_INT}))+gt(scene\,${SCENE_THRESHOLD})',showinfo" \
    -vsync vfr \
    -q:v 3 \
    "$OUTPUT_DIR/frames/f_%04d.jpg" \
    2> "$OUTPUT_DIR/frames/showinfo_raw.txt" || true

# Parse timestamps from showinfo output
grep "pts_time" "$OUTPUT_DIR/frames/showinfo_raw.txt" | \
    sed 's/.*pts_time:\([0-9.]*\).*/\1/' > "$OUTPUT_DIR/frames/timestamps.txt" 2>/dev/null || true

# Extract audio as separate file for Gemini analysis
# aresample=async=1 fills gaps in audio packets from AVFoundation/BlackHole capture,
# which delivers sparse audio frames spread across the full video timeline.
ffmpeg -v warning -i "$CHUNK" \
    -vn -af "aresample=async=1" -acodec libmp3lame -q:a 4 \
    "$OUTPUT_DIR/audio/audio.mp3" 2>/dev/null || echo "⚠️  No audio track found"

# Extract spectrogram image
ffmpeg -v warning -i "$CHUNK" \
    -lavfi "showspectrumpic=s=800x200:mode=combined:color=intensity" \
    "$OUTPUT_DIR/audio/spectrogram.png" 2>/dev/null || echo "⚠️  Could not generate spectrogram"

# Extract volume levels
ffmpeg -v warning -i "$CHUNK" \
    -af "volumedetect" -f null /dev/null 2>&1 | \
    grep -E "mean_volume|max_volume|histogram" > "$OUTPUT_DIR/audio/volume.txt" 2>/dev/null || true

# Generate summary
FRAME_COUNT=$(ls "$OUTPUT_DIR/frames"/f_*.jpg 2>/dev/null | wc -l | tr -d ' ')
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CHUNK" | head -1)
HAS_AUDIO="no"
[[ -f "$OUTPUT_DIR/audio/audio.mp3" ]] && HAS_AUDIO="yes"

cat > "$OUTPUT_DIR/manifest.json" << EOF
{
  "source": "$(basename "$CHUNK")",
  "duration_seconds": $DURATION,
  "fps": $FPS_INT,
  "frame_count": $FRAME_COUNT,
  "scene_threshold": $SCENE_THRESHOLD,
  "short_edge": $SHORT_EDGE,
  "has_audio": $HAS_AUDIO,
  "frames_dir": "frames/",
  "timestamps_file": "frames/timestamps.txt",
  "audio_file": "audio/audio.mp3",
  "spectrogram": "audio/spectrogram.png"
}
EOF

echo "✅ Done: $FRAME_COUNT frames extracted | audio: $HAS_AUDIO | duration: ${DURATION}s"
