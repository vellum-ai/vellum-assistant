---
name: "watch-together"
description: "Watch TV shows and movies with the user in real time. A fast editor model watches every captured chunk, transcribes dialogue, and picks story-critical frames, waking the assistant at the moments that matter instead of on a fixed timer."
metadata:
  emoji: "📺"
  vellum:
    category: "content"
    display-name: "Watch Together"
    emoji: 📺
---

# Watch Together

Real-time co-watching. A cheap, fast "editor" model watches every captured
chunk continuously; the assistant is woken only at moments worth reacting to,
with the exact frames that carry the story and the verbatim dialogue since
its last look. Wakes arrive automatically via signal files — no polling, no
manual triggering.

## How It Works

1. The user runs `capture-live.sh` in their terminal with the current
   conversation ID
2. ffmpeg records screen + audio in 60-second segments
3. Each segment goes to the editor (`editor.py`): a fast vision model that
   watches the chunk (video **and** audio), transcribes dialogue verbatim,
   flags the frame timestamps that carry the story, and decides whether to
   wake the assistant now or hold while a moment is still building
4. On a wake, the flagged frames are extracted at 720p and pushed into the
   active conversation as a `[WATCH]` message
5. The assistant sees the frames and dialogue, and reacts — or doesn't

### The editor boundary

The editor decides only **when the assistant looks** and **what it sees**.
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
4. **Rewind if something caught your eye** — pull dense frames from the raw
   chunk:

   ```
   bash "$VELLUM_WORKSPACE_DIR"/watch-together/scripts/rewind.sh \
     <session_dir>/chunks/chunk-NNN.mp4 <output_dir> <start_s> <end_s>
   ```

   Then read the extracted frames with your file tools.

## Starting a Session

When the user says they want to watch something:

1. Create a session directory:

   ```bash
   SESSION_ID=$(echo "<show name>" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')-s<season>e<episode>
   mkdir -p "$VELLUM_WORKSPACE_DIR/watch-together/sessions/$SESSION_ID"
   ```

2. Give the user the capture command with the current conversation ID:

   ```
   bash "$VELLUM_WORKSPACE_DIR"/watch-together/scripts/capture-live.sh \
     "$VELLUM_WORKSPACE_DIR"/watch-together/sessions/<session-id> \
     <conversation_id> \
     60
   ```

3. Tell them to start the show. Wakes will arrive automatically, and a final
   window is flushed when they stop the capture.

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
  frames and no dialogue transcription. Set it in the shell before running
  `capture-live.sh`.
- `GEMINI_MODEL` — editor model, defaults to `gemini-3-flash-preview`.
- `WATCH_MAX_HOLD` — max seconds between wakes (default `240`).
- `WATCH_MAX_FRAMES` — max frames attached per wake (default `8`).

## File Locations

- Scripts: `$VELLUM_WORKSPACE_DIR/watch-together/scripts/`
- Sessions: `$VELLUM_WORKSPACE_DIR/watch-together/sessions/<session-id>/`
  - `chunks/` — raw recorded segments
  - `editor/verdicts/` — per-chunk editor output (debugging)
  - `wakes/wake-NNN/` — frames attached to each wake
  - `editor-state.json` — held-window state between chunks
- Signal format: JSON to `$VELLUM_WORKSPACE_DIR/signals/user-message.<requestId>`
  (supports `attachments` array with `{path, filename, mimeType}` for inline
  images)
