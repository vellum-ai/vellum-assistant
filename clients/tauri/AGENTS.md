# Eli HUD (Tauri client) — Agent Instructions

The Tauri client is a desktop "Jarvis HUD" that talks to the local
assistant gateway. The app's job is purely presentational + voice IO;
all business logic lives in the daemon.

## Boundaries

- **Talk to the gateway, never the runtime directly.** The Tauri app
  resolves the local gateway URL via `~/.vellum.lock.json`
  (`resolveLocalAssistantConnection()` in `src/services/lockfile.ts`).
  Never construct a runtime URL using port 7821 — see the top-level
  `gateway/AGENTS.md` for the full rationale.
- **Don't import from `assistant/` or `gateway/`.** This client is a
  separate package; it duplicates the small wire-shape types it needs
  (live-voice frames, SSE envelope) so the daemon and HUD can evolve
  independently. If the wire shapes drift, the HUD becomes the
  consumer of a versioned gateway contract — not a transitive importer.
- **Do not access user `~/.vellum/` files beyond the lockfile.** Per
  the top-level `clients/AGENTS.md`, clients must not read into the
  workspace. The lockfile is the only sanctioned cross-package path.

## Voice pipeline

The HUD owns the live mic stream and (optionally) runs Picovoice
Porcupine wake-word detection inside the WebView via
`@picovoice/porcupine-web`. On wake, it opens a `/v1/live-voice`
WebSocket to the gateway and streams 16 kHz int16 mono PCM frames as
base64 JSON `audio` frames per `assistant/src/live-voice/protocol.ts`.

When the user is silent for `voice.vad.silenceMs` (default 700ms),
the HUD sends `ptt_release` so the daemon endpoints the turn. While
the daemon is speaking (`tts_audio` frames arriving), any user audio
above ~0.04 RMS triggers a barge-in via the `interrupt` frame.

Push-to-talk is exposed through `useVoiceEngine().toggleListening()`
so the command bar's "talk" button and (future) global hotkey can
force an active turn even when the wake word is disabled.

## Configuration

- `PICOVOICE_ACCESS_KEY` env var is read at runtime by the Rust
  command `picovoice_access_key`. Without it, wake-word silently
  disables and the HUD falls back to PTT.
- The daemon's `voice.*` config drives runtime knobs (sensitivity,
  VAD thresholds, keyword list). Currently the HUD takes a hardcoded
  default snapshot — when the user wires `vellum hatch --config
  voice.alwaysOn=true`, the HUD will sync via the existing
  config-broadcast SSE event in a future revision.

## Build

The Tauri shell requires Rust toolchain on the developer's machine;
React layer builds with Bun. See `README.md` for the install dance.

## What's intentionally not here

- No settings UI. Users manage config via the existing macOS
  `vellum-assistant` Settings or the CLI.
- No multi-instance / cloud-runtime selector. Auto-discovery picks
  the most-recently-hatched local instance.
- No persistent transcript storage. The transcript pane is an
  ephemeral rolling view; conversation state lives in the daemon.
