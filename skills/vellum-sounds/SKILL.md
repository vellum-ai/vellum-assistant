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
- **`config.json`** — a single JSON file that stores the global on/off switch, the master volume, and a per-event map of `{ enabled, sound }`.

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

Use `scripts/update-config.ts` to edit `config.json`. It validates inputs, creates the file with defaults if missing, and writes atomically so a crash can't corrupt it.

```bash
bun run scripts/update-config.ts --global-enabled true
bun run scripts/update-config.ts --volume 0.5
bun run scripts/update-config.ts --event message_sent --enabled true --sound "gentle-ding.aiff"
bun run scripts/update-config.ts --event random --enabled false
bun run scripts/update-config.ts --event task_complete --sound null   # revert to default blip
```

Flag reference:

| Flag | Value | Effect |
|---|---|---|
| `--global-enabled` | `true` or `false` | Master switch. If `false`, NOTHING plays regardless of per-event settings. |
| `--volume` | `0.0`–`1.0` (clamped) | Master volume. `0.7` is the default. |
| `--event` | one of the 9 keys above | Scopes the next flags to a single event. |
| `--enabled` | `true` or `false` | Per-event on/off (requires `--event`). |
| `--sound` | filename or `null` | Which file to play for this event (requires `--event`). `null` = macOS "Tink" default blip. The file must already exist in `data/sounds/`. |

The script prints the resulting config slice so you can confirm what changed.

## Mode 4: Remove a sound file

```bash
rm "$VELLUM_WORKSPACE_DIR/data/sounds/<filename>"
```

Then clear any event that referenced it, so the config doesn't dangle:

```bash
bun run scripts/update-config.ts --event <key> --sound null
```

(The macOS app already falls back to the default blip if a referenced file is missing, but cleaning up the config is tidier.)

## UX Guidelines

- **Always check current state first.** Don't ask "what do you want to do" if they already have sounds configured — summarize what's set up, then ask what to change.
- **The master switch is the #1 gotcha.** `globalEnabled` defaults to `false`. If the user assigns a sound to an event and doesn't hear anything, check that flag first. When assigning the user's first sound, offer to flip the master switch on for them.
- **Per-event enabled is the #2 gotcha.** Each event has its own `enabled` bool. Setting `sound` alone doesn't enable the event.
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
    "app_open":         { "enabled": false, "sound": null },
    "task_complete":    { "enabled": false, "sound": null },
    "needs_input":      { "enabled": false, "sound": null },
    "task_failed":      { "enabled": false, "sound": null },
    "notification":     { "enabled": false, "sound": null },
    "new_conversation": { "enabled": false, "sound": null },
    "message_sent":     { "enabled": false, "sound": null },
    "character_poke":   { "enabled": false, "sound": null },
    "random":           { "enabled": false, "sound": null }
  }
}
```
