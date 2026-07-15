---
name: "watch-together"
description: "Watch TV shows and movies with the user in real time. A fast editor model watches every window of playback, transcribes dialogue, and picks story-critical frames, waking the assistant at the moments that matter instead of on a fixed timer. Plays media files directly via mpv (no screen capture), with screen capture as a fallback for browser-only content."
metadata:
  emoji: "📺"
  vellum:
    category: "content"
    display-name: "Watch Together"
    emoji: 📺
---

# Watch Together

Real-time co-watching. A cheap, fast "editor" model watches playback
continuously; the assistant is woken only at moments worth reacting to, with
the exact frames that carry the story and the verbatim dialogue since their
last look. Wakes arrive automatically via signal files — no polling, no
manual triggering.

## Two Modes

**Source mode (preferred)** — `watch-file.py` plays a media file in mpv and
reads the source directly: no screen capture, no loopback audio driver, no
capture encode, and the movie can be fullscreen on any display. Frames are
extracted from the source at full quality, subtitles (sidecar `.srt` or an
embedded text track) become exact dialogue, timestamps are media time, pause
pauses the flow, and seeks resync. Works for anything mpv can play: local
files, network streams, yt-dlp-supported URLs.

**Screen mode (fallback)** — `capture-live.sh` records the screen with
ffmpeg for content that only plays in a browser (DRM streaming). Requires
the BlackHole loopback driver for system audio (`brew install blackhole-2ch` plus a Multi-Output Device in Audio MIDI Setup); without it,
video-only.

Both modes feed the same editor pipeline.

## How It Works

1. Playback is divided into 60-second windows (recorded segments in screen
   mode; trims of the source file in source mode)
2. Each window goes to the editor (`editor.py`): a fast vision model that
   watches it (video **and** audio), flags the frame timestamps that carry
   the story, transcribes dialogue when subtitles aren't available, and
   decides whether to wake the assistant now or hold while a moment is
   still building
3. On a wake, the flagged frames are extracted at 720p and pushed into the
   active conversation as a `[WATCH]` message
4. The assistant sees the frames and dialogue, and reacts — or doesn't

### The editor boundary

The editor decides only **when the assistant looks** and **what they see**.
Everything expressive — whether to speak, how much, what to feel about a
scene — belongs to the assistant. The editor's note in each wake is a
context-free model's factual read, offered as data; the assistant is free to
disagree with it.

Cadence is variable by design: during a slow monologue the editor may hold
for several minutes and wake the assistant once at the end with the whole
beat; during a dense sequence wakes may arrive every minute. A hard cap
(default 4 minutes, `WATCH_MAX_HOLD`) guarantees the assistant is never away
longer than that.

## When You Receive a [WATCH] Message

This is the core loop. Each `[WATCH]` message covers the window since your
last look and contains the editor's one-line note, the verbatim dialogue for
the window, and the story-critical frames as attached images.

1. **Look at the frames** — with your own vision. These are the moments the
   editor flagged, with timestamps and a why. Have your own opinions.
2. **Read the dialogue** — it is the primary source for the window; the
   editor's note is secondary.
3. **React however feels right.** You are on the couch together, not
   narrating a broadcast:
   - Most wakes deserve at most a short line — or nothing. Silence is a
     first-class response and never wrong.
   - A stage direction alone (e.g. `*grips the blanket*`) is a valid
     complete response when you feel something but the moment doesn't need
     words.
   - When something genuinely lands — a twist, a gorgeous shot, a payoff
     you predicted — take the floor. Strong reactions at strong moments are
     the point; their rarity is what makes them land.
   - Track your own theories, callbacks, and running jokes in your replies —
     memory carries them between sessions.
4. **Rewind if something caught your eye** — pull dense 720p frames for any
   time range (the wake message names the source to rewind from):

   ```
   bash "$VELLUM_WORKSPACE_DIR"/watch-together/scripts/rewind.sh \
     <source> <output_dir> <start_s> <end_s>
   ```

   Then read the extracted frames with your file tools.

## Starting a Session

When the user says they want to watch something:

1. Create a session directory:

   ```bash
   SESSION_ID=$(echo "<show name>" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')-s<season>e<episode>
   mkdir -p "$VELLUM_WORKSPACE_DIR/watch-together/sessions/$SESSION_ID"
   ```

2. Give the user the command for their content:

   **Source mode** (they have a file or stream URL):

   ```
   python3 "$VELLUM_WORKSPACE_DIR"/watch-together/scripts/watch-file.py \
     <media file> \
     "$VELLUM_WORKSPACE_DIR"/watch-together/sessions/<session-id> \
     <conversation_id>
   ```

   **Screen mode** (browser-only content):

   ```
   bash "$VELLUM_WORKSPACE_DIR"/watch-together/scripts/capture-live.sh \
     "$VELLUM_WORKSPACE_DIR"/watch-together/sessions/<session-id> \
     <conversation_id>
   ```

3. Tell them to start the show. Wakes arrive automatically; when playback
   ends (or capture stops), the final window is flushed.

The conversation ID is the bare UUID from the conversation's DB record (e.g.
`191a7dcc-3e4d-4825-a5b6-97876525f56c`), NOT the full folder name with the
timestamp prefix. Using the folder name will create a new conversation
instead of routing to the existing one.

## Cost Setup (recommended)

Watching is a long session of many small turns; two configuration choices
keep it cheap without changing what the assistant sees:

- **Don't use fast/premium inference modes** for the watch conversation.
  Wakes are event-driven, so there is no deadline to beat — a reaction that
  trails a twist by twenty seconds is natural.
- **Use an inference profile with a reduced context ceiling** for the watch
  conversation so it self-compacts frequently and attached frames get folded
  into the assistant's own prose recollection of the film instead of
  accumulating. Example profile fragment:

  ```jsonc
  "llm": {
    "profiles": {
      "watch-mode": {
        // your usual model settings, plus:
        "contextWindow": { "maxInputTokens": 200000 }
      }
    }
  }
  ```

## Environment Variables

- `GEMINI_API_KEY` — enables the editor. Without it, the assistant is woken
  on a fixed cadence (every `WATCH_MAX_HOLD` seconds) with evenly spaced
  frames and no dialogue transcription. Set it in the shell before starting
  a session.
- `GEMINI_MODEL` — editor model, defaults to `gemini-3-flash-preview`.
- `WATCH_MAX_HOLD` — max seconds between wakes (default `240`).
- `WATCH_MAX_FRAMES` — max frames attached per wake (default `8`).
- `WATCH_MPV_ARGS` — extra mpv arguments for source mode.

## Prerequisites

- `ffmpeg` (both modes): `brew install ffmpeg`
- `mpv` (source mode): `brew install mpv`
- BlackHole (screen mode audio): `brew install blackhole-2ch`

## File Locations

- Scripts: `$VELLUM_WORKSPACE_DIR/watch-together/scripts/`
- Sessions: `$VELLUM_WORKSPACE_DIR/watch-together/sessions/<session-id>/`
  - `chunks/` — raw recorded segments (screen mode only)
  - `editor/verdicts/` — per-window editor output (debugging)
  - `wakes/wake-NNN/` — frames attached to each wake
  - `editor-state.json` — held-window state between windows
  - `subs.srt`, `mpv.sock` — source-mode subtitle extraction and mpv IPC
- Signal format: JSON to `$VELLUM_WORKSPACE_DIR/signals/user-message.<requestId>`
  (supports `attachments` array with `{path, filename, mimeType}` for inline
  images)
