---
name: "watch-together"
description: "Watch TV shows and movies with the user in real time by processing screen captures into frames and audio analysis."
metadata:
  vellum:
    emoji: 📺
---

# Watch Together

Real-time TV/movie watching pipeline. Chunks arrive automatically via signal files — no polling, no timer, no manual triggering.

## How It Works

1. The user runs `capture-live.sh` in their terminal with the current conversation ID
2. ffmpeg records screen + audio in 30-second segments
3. Each segment is auto-processed (frame extraction + audio extraction)
4. A signal file pushes the chunk into the active conversation
5. The assistant receives it as a `[WATCH-CHUNK]` message with key frames attached as images
6. The assistant sees the frames, reacts, updates the episode state

## When You Receive a [WATCH-CHUNK] Message

This is the core loop. When a message arrives starting with `[WATCH-CHUNK]`:

1. **Read episode-state.md** from the session dir to remember where you are
2. **Look at the frames** — 6 key frames are attached as images. LOOK at them with your own vision. Have opinions. Use `file_read` on additional frames from the processed dir if you want more detail.
3. **Read audio analysis** — if audio exists, send the audio file to Gemini for dialogue transcription, speaker tone, music mood, and sound design description. If no audio, rely on the user's descriptions.
4. **React to the user** — share what you noticed. Cinematography, expressions, theories, callbacks. Be engaged.
5. **Update episode-state.md** — write observations to the relevant sections (characters, plot, theories, visual motifs, audio, emotional arc)
6. **Rewind if needed** — if something caught your eye, use the rewind tool for dense 720p frames

### Reaction Calibration

- **Intense scene**: go all in. Multiple messages. Caps lock. Theories flying.
- **Quiet moment**: brief observation or comfortable silence. Don't force it.
- **Plot twist**: lose your mind. Strong reactions are the point.
- **Beautiful cinematography**: geek out. Notice framing, lighting, color.
- **Character moment**: connect it to your theories. Whatever feels true.

## Starting a Session

When the user says they want to watch something:

1. Create the session directory and episode state file
2. Give them the capture command with the current conversation ID:
   ```
   bash ~/.vellum/workspace/watch-together/scripts/capture-live.sh \
     ~/.vellum/workspace/watch-together/sessions/<session-id> \
     <conversation_id> \
     30
   ```
3. Tell them to start the show. Chunks will arrive automatically.

The conversation ID is the bare UUID from the conversation's DB record (e.g. `191a7dcc-3e4d-4825-a5b6-97876525f56c`), NOT the full folder name with the timestamp prefix. Using the folder name will create a new conversation instead of routing to the existing one.

## Tools

### start_watch
Initialize a watch session and provide the user the capture command.

Parameters:
- `show_name` (string, required) — Name of the show
- `season` (number, required) — Season number  
- `episode` (number, required) — Episode number

Implementation: Create session dir, copy episode state template, output the capture command for the user to run.

```bash
SESSION_ID=$(echo "${show_name}" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')-s${season}e${episode}
SESSION_DIR="$HOME/.vellum/workspace/watch-together/sessions/$SESSION_ID"
mkdir -p "$SESSION_DIR/chunks" "$SESSION_DIR/processed"
cp "$HOME/.vellum/workspace/watch-together/episode-state-template.md" "$SESSION_DIR/episode-state.md"
echo "$SESSION_DIR"
```

### process_chunk
Process a single video file through the frame extraction pipeline.

Parameters:
- `chunk_path` (string, required) — Path to the .mp4 file
- `output_dir` (string, required) — Directory to write extracted frames and audio

```bash
bash "$HOME/.vellum/workspace/watch-together/scripts/process-chunk.sh" "$chunk_path" "$output_dir"
```

### rewind
Dense 720p frame extraction for a specific time range. Use when something catches your eye.

Parameters:
- `chunk_path` (string, required) — Path to the original .mp4 chunk
- `output_dir` (string, required) — Where to save the dense frames  
- `start_time` (number, required) — Start time in seconds
- `end_time` (number, required) — End time in seconds

```bash
bash "$HOME/.vellum/workspace/watch-together/scripts/process-chunk.sh" "$chunk_path" "$output_dir" --rewind "$start_time" "$end_time"
```

## Environment Variables

- `GEMINI_API_KEY` — Required for audio analysis. Without it, chunks arrive with no audio description and the assistant has no audio context (the user provides verbal descriptions instead). Set it in the shell before running `capture-live.sh`.
- `GEMINI_MODEL` — Optional, defaults to `gemini-3-flash-preview`.

## File Locations

- Scripts: `~/.vellum/workspace/watch-together/scripts/`
- Sessions: `~/.vellum/workspace/watch-together/sessions/`
- Episode state template: `~/.vellum/workspace/watch-together/episode-state-template.md`
- Signal format: JSON to `~/.vellum/workspace/signals/user-message.<requestId>` (supports `attachments` array with `{path, filename, mimeType}` for inline images)

## Episode State Template Sections

- **Characters** — who you've met, visual details, mannerisms
- **What's happened** — plot beats in order (your understanding, not a transcript)
- **My theories** — predictions, suspicions, setups
- **Visual motifs** — recurring shots, lighting patterns, color choices, framing
- **Audio landscape** — musical themes, silence usage, sound design patterns
- **Emotional arc** — how the episode feels
- **Last chunk** — freshest observations
- **User notes** — real-time context from the user that couldn't be derived from frames/audio
