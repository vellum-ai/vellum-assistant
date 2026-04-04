#!/bin/bash
# analyze-audio.sh — Send audio to Gemini for description
# Usage: ./analyze-audio.sh <audio_file> <output.json> [prompt_file]
#
# If prompt_file is provided, uses that as the analysis prompt.
# Otherwise uses a default comprehensive audio description prompt.
#
# Requires: GEMINI_API_KEY environment variable

set -euo pipefail

AUDIO_FILE="${1:?Usage: analyze-audio.sh <audio_file> <output.json> [prompt_file]}"
OUTPUT_FILE="${2:?Missing output file path}"
PROMPT_FILE="${3:-}"

MODEL="${GEMINI_MODEL:-gemini-3-flash-preview}"

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
    echo "❌ GEMINI_API_KEY not set"
    exit 1
fi

API_URL="https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}"

# Detect MIME type
case "${AUDIO_FILE##*.}" in
    mp3) MIME_TYPE="audio/mpeg" ;;
    wav) MIME_TYPE="audio/wav" ;;
    m4a) MIME_TYPE="audio/mp4" ;;
    aac) MIME_TYPE="audio/aac" ;;
    ogg) MIME_TYPE="audio/ogg" ;;
    mp4) MIME_TYPE="video/mp4" ;;
    *)   MIME_TYPE="audio/mpeg" ;;
esac

# Load prompt
if [[ -n "$PROMPT_FILE" ]] && [[ -f "$PROMPT_FILE" ]]; then
    PROMPT=$(cat "$PROMPT_FILE")
else
    PROMPT="Analyze this audio clip and describe everything you hear:

1. **Dialogue**: Transcribe all spoken lines with approximate timestamps (e.g. [0:05]). For each line, describe the speaker's voice (pitch, age, quality) and delivery (tone, emotion, volume, pacing — e.g. whispering, shouting, trembling, sarcastic, flat, tender, desperate).

2. **Music**: Describe any music — mood, instruments, intensity, tempo, key feeling. How does it change across the clip? Note if there is NO music — silence is a deliberate choice.

3. **Sound Design**: Non-speech, non-music audio. Ambient sounds, foley, environmental atmosphere — footsteps, doors, wind, rain, glass, fabric, breathing, crowd noise, mechanical sounds, anything.

4. **Emotional Arc**: How does the audio feel across the full duration? Where are the peaks and valleys? What is the sound trying to make the listener feel?

5. **Silence & Pauses**: Note any significant silence or pauses. Duration, what surrounds them, what they communicate.

Be specific and vivid. Describe what you hear as if translating sound for someone who cannot hear it."
fi

# Build request with python (handles base64 encoding cleanly)
python3 -c "
import json, base64, sys

with open('$AUDIO_FILE', 'rb') as f:
    audio_b64 = base64.b64encode(f.read()).decode()

prompt = open('$PROMPT_FILE', 'r').read() if '$PROMPT_FILE' and '$PROMPT_FILE' != '' else '''$(echo "$PROMPT" | sed "s/'/\\\\'/g")'''

request = {
    'contents': [{
        'parts': [
            {
                'inlineData': {
                    'mimeType': '$MIME_TYPE',
                    'data': audio_b64
                }
            },
            {'text': prompt}
        ]
    }],
    'generationConfig': {
        'temperature': 0.7,
        'maxOutputTokens': 2048
    }
}

json.dump(request, sys.stdout)
" > /tmp/gemini-audio-request.json

echo "🎧 Analyzing audio with $MODEL..."

HTTP_CODE=$(curl -s -w "%{http_code}" -o "$OUTPUT_FILE.raw" \
    -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -d @/tmp/gemini-audio-request.json)

rm -f /tmp/gemini-audio-request.json

if [[ "$HTTP_CODE" != "200" ]]; then
    echo "❌ Gemini API error (HTTP $HTTP_CODE)"
    cat "$OUTPUT_FILE.raw" 2>/dev/null | head -5
    rm -f "$OUTPUT_FILE.raw"
    exit 1
fi

python3 -c "
import json
with open('$OUTPUT_FILE.raw') as f:
    resp = json.loads(f.read())
text = resp['candidates'][0]['content']['parts'][0]['text']
with open('$OUTPUT_FILE', 'w') as f:
    json.dump({'audio_analysis': text, 'model': '$MODEL'}, f, indent=2)
print(text)
"

rm -f "$OUTPUT_FILE.raw"
echo "✅ Audio analysis saved to $OUTPUT_FILE"
