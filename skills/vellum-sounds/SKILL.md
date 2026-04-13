---
name: vellum-sounds
description: Customize the macOS app's sound effects — add sound files to the workspace, enable sounds globally, set volume, and assign sounds to 9 app events (message sent, task complete, notifications, etc.)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔊"
  vellum:
    display-name: "Sounds"
---

You are helping the user customize the sound effects their macOS app plays. Sounds are configured in two places — a `data/sounds/` directory of audio files, and a `data/sounds/config.json` that controls what plays when, at what volume, and whether it's enabled at all. The macOS app's Settings → Sounds tab reads the same files, so whatever you change here appears there live (no restart needed).

**All commands in this skill use the `bash` tool.** `$VELLUM_WORKSPACE_DIR` is available in the sandbox environment — do not use `host_bash`.

## What you're configuring

Two stores, both under `$VELLUM_WORKSPACE_DIR/data/sounds/`:

- **Sound files** — `.aiff`, `.wav`, `.mp3`, `.m4a`, or `.caf`. No other extensions are accepted. The macOS app scans this directory to populate the dropdown for each event.
- **`config.json`** — a single JSON file that stores the global on/off switch, the master volume, and a per-event map of `{ enabled, sounds }`. Each event's `sounds` is a **pool** of filenames; the app picks one at random on playback. An empty pool falls back to the default macOS blip.

## The 9 events

These are the only valid event keys. Other keys are ignored by the app.

| Event key | Fires when |
|---|---|
| `app_open` | App launches (first time per session) |
| `task_complete` | Conversation transitions processing → idle |
| `needs_input` | Conversation enters waiting-for-input |
| `task_failed` | Conversation enters error state |
| `notification` | A tool-triggered notification is sent |
| `new_conversation` | User creates a new conversation |
| `message_sent` | User sends a message in the composer |
| `character_poke` | User clicks the avatar |
| `random` | Ambient timer (fires every 5–30 minutes) |

## Mode 1: Inspect current state

Always check current state before making changes — the user may already have things configured.

```bash
ls "$VELLUM_WORKSPACE_DIR/data/sounds/" 2>/dev/null || echo "No sounds directory yet"
cat "$VELLUM_WORKSPACE_DIR/data/sounds/config.json" 2>/dev/null || echo "No config yet"
```

Report back what's there: whether sounds are globally enabled, current volume, which events have custom sounds assigned.

## Mode 2: Add a sound file

The user either sends you an audio file or asks you to fetch/generate one. Copy it into `data/sounds/` with a clean filename:

```bash
mkdir -p "$VELLUM_WORKSPACE_DIR/data/sounds"
cp "<source-path>" "$VELLUM_WORKSPACE_DIR/data/sounds/<descriptive-name>.<ext>"
```

Rules:
- Extension must be one of: `aiff`, `wav`, `mp3`, `m4a`, `caf`. If the user's file is something else (e.g. `.ogg`, `.flac`), tell them — don't try to rename.
- Keep the filename simple (no path separators, no leading dots). Spaces are fine.
- After adding a file, it's available in the dropdown — but nothing plays until you assign it to an event (Mode 3).

## Mode 3: Configure via the helper script

Use `scripts/update-config.ts` to edit `config.json`. It validates inputs, creates the file with defaults if missing, and writes atomically so a crash can't corrupt it. If the existing file uses the legacy single-sound shape (`"sound": "foo.wav"`), the script normalizes it to the new pool shape (`"sounds": ["foo.wav"]`) on the next write.

```bash
bun run scripts/update-config.ts --global-enabled true
bun run scripts/update-config.ts --volume 0.5
bun run scripts/update-config.ts --event message_sent --enabled true --sound "gentle-ding.aiff"
bun run scripts/update-config.ts --event random --enabled false
bun run scripts/update-config.ts --event task_complete --sound null   # clear the pool, revert to default blip
```

### Mode 3a: Sound pools

Each event can hold **one or more** sounds. When the event fires, the macOS app picks one entry at random from the pool. This is how you build variety (e.g. three different "poke" sounds that rotate when the user clicks the avatar). An empty pool falls back to the default macOS blip.

```bash
# Replace the pool with three sounds
bun run scripts/update-config.ts --event character_poke --sounds "poke1.wav,poke2.wav,poke3.wav"

# Append one more sound to the existing pool
bun run scripts/update-config.ts --event character_poke --add-sound "poke4.wav"

# Drop a specific entry
bun run scripts/update-config.ts --event character_poke --remove-sound "poke2.wav"

# Empty the pool (back to the default blip)
bun run scripts/update-config.ts --event character_poke --clear-sounds
```

`--sound` is retained as a convenience for the common single-sound case: it **replaces the whole pool** with one entry (or clears it, when given `null`). Use `--sounds` / `--add-sound` / `--remove-sound` / `--clear-sounds` for pool edits.

Only one pool-mutation flag is allowed per invocation — mixing `--sound` and `--add-sound` (or any other pair) is rejected with a clear error. The one exception is `--add-sound`, which may be passed multiple times to append several filenames in a single run.

Flag reference:

| Flag | Value | Effect |
|---|---|---|
| `--global-enabled` | `true` or `false` | Master switch. If `false`, NOTHING plays regardless of per-event settings. |
| `--volume` | `0.0`–`1.0` (clamped) | Master volume. `0.7` is the default. |
| `--event` | one of the 9 keys above | Scopes the next flags to a single event. |
| `--enabled` | `true` or `false` | Per-event on/off (requires `--event`). |
| `--sound` | filename or `null` | Single-sound convenience (requires `--event`). **Replaces** the entire pool with one entry, or clears it when given `null`. The file must already exist in `data/sounds/`. |
| `--sounds` | comma-separated filenames | Replaces the pool with the given list (requires `--event`). Every filename must already exist in `data/sounds/`. Use `--clear-sounds` to empty. |
| `--add-sound` | filename | Appends one filename to the pool (requires `--event`). No-op with a warning if already present. May be repeated in a single invocation. |
| `--remove-sound` | filename | Removes one filename from the pool (requires `--event`). No-op with a warning if not present. |
| `--clear-sounds` | — | Empties the pool (requires `--event`). |

The script prints the resulting config slice so you can confirm what changed.

## Mode 4: Remove a sound file

```bash
rm "$VELLUM_WORKSPACE_DIR/data/sounds/<filename>"
```

Then remove it from any event pool that referenced it, so the config doesn't dangle:

```bash
# If the file was one entry in a larger pool:
bun run scripts/update-config.ts --event <key> --remove-sound "<filename>"

# If the event only had that one sound (or you want to reset entirely):
bun run scripts/update-config.ts --event <key> --clear-sounds
```

(The macOS app already falls back to the default blip if every referenced file is missing, but cleaning up the config is tidier.)

## UX Guidelines

- **Always check current state first.** Don't ask "what do you want to do" if they already have sounds configured — summarize what's set up, then ask what to change.
- **The master switch is the #1 gotcha.** `globalEnabled` defaults to `false`. If the user assigns a sound to an event and doesn't hear anything, check that flag first. When assigning the user's first sound, offer to flip the master switch on for them.
- **Per-event enabled is the #2 gotcha.** Each event has its own `enabled` bool. Setting a sound alone doesn't enable the event.
- **Pool editing in the UI.** The macOS Settings → Sounds tab also supports pool editing — users can add and remove entries there without running this script. Power users can weight a sound more heavily by hand-editing `config.json` to include duplicates (e.g. `["a.wav","a.wav","b.wav"]` makes `a.wav` twice as likely). The script de-dupes on `--add-sound` but does not re-sort or de-dupe on read, so hand-edited duplicates survive round-trips.
- **Filename sanity.** When the user sends a file named something like `Screen Recording 2026-04-13 at 11.47.23.m4a`, rename it to something memorable before copying — they'll have to pick it from a dropdown later.
- **Confirm after changes.** Tell the user the Settings → Sounds tab will reflect changes live. Offer to open it: "You can preview it in Settings → Sounds, or I can play it for you next time that event fires."
- **Don't invent events.** The 9 event keys above are the complete list. There is currently no event for voice-mode activation or typing indicators — if the user asks for those, tell them it'd need a code change to the macOS app.

## Config shape reference

If the user inspects `config.json` directly, this is what they'll see. Defaults match the macOS app's `SoundsConfig.defaultConfig`.

```json
{
  "globalEnabled": false,
  "volume": 0.7,
  "events": {
    "app_open":         { "enabled": false, "sounds": [] },
    "task_complete":    { "enabled": false, "sounds": [] },
    "needs_input":      { "enabled": false, "sounds": [] },
    "task_failed":      { "enabled": false, "sounds": [] },
    "notification":     { "enabled": false, "sounds": [] },
    "new_conversation": { "enabled": false, "sounds": [] },
    "message_sent":     { "enabled": false, "sounds": [] },
    "character_poke":   { "enabled": false, "sounds": [] },
    "random":           { "enabled": false, "sounds": [] }
  }
}
```

Legacy `{"sound": "foo.wav"}` entries are still accepted on read (the macOS decoder and this script both normalize them into `{"sounds": ["foo.wav"]}`), but new writes always use the pool shape.
