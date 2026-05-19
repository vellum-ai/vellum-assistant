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

The HUD owns the live mic stream and runs a permission-free
voice-activity wake inside `hooks/use-voice-engine.ts`: while
`voice.alwaysOn` is true, sustained mic energy above
`SPEECH_WAKE_TRIGGER_RMS` for `SPEECH_WAKE_TRIGGER_FRAMES` opens a
`/v1/live-voice` WebSocket. The HUD then streams 16 kHz int16 mono
PCM frames as base64 JSON `audio` frames per
`assistant/src/live-voice/protocol.ts` and lets the daemon's
server-side STT do the heavy lifting (including detecting "Eli, …" in
the first transcribed turn).

When the user is silent for `voice.vad.silenceMs` (default 1100ms),
the HUD sends `ptt_release` so the daemon endpoints the turn. While
the daemon is speaking (`tts_audio` frames arriving), any user audio
above ~0.04 RMS triggers a barge-in via the `interrupt` frame.

Push-to-talk is exposed through `useVoiceEngine().toggleListening()`
so the command bar's "talk" button and the global hotkey can force an
active turn even when always-on is disabled.

**No client-side keyword spotting.** Two earlier approaches failed
hard and must not be re-introduced without solving their root causes:

1. **Picovoice Porcupine** only recognises a fixed list of built-in
   keywords (`Alexa`, `Jarvis`, `Computer`, etc.) — "Eli" is not on
   that list. Using it for this product would have required every user
   to train a custom `.ppn` at console.picovoice.ai and ship a
   third-party access key.
2. **`webkitSpeechRecognition` in WKWebView** (Apple's on-device
   `SFSpeechRecognizer`) crashes the host process under macOS TCC when
   the binary is not properly code-signed. Specifically, an unsigned
   `tauri dev` binary has no stable code identity, so TCC kills it
   with `EXC_CRASH / SIGABRT` the moment WebKit engages
   `SFSpeechRecognizer`, even when `NSSpeechRecognitionUsageDescription`
   is present in the embedded `Info.plist`. This is why the HUD's
   `Info.plist` deliberately does **not** declare
   `NSSpeechRecognitionUsageDescription` — we never want WebKit to
   attempt that code path here.

A keyword-aware wake can return once we ship a properly bundled +
code-signed `.app`, but the implementation MUST gate behind a runtime
check that the host process is code-signed; otherwise dev/preview
builds will crash on first launch.

## Configuration

- The daemon's `voice.*` config drives runtime knobs (sensitivity,
  VAD thresholds, keyword list). Currently the HUD takes a hardcoded
  default snapshot — when the user wires `vellum hatch --config
  voice.alwaysOn=true`, the HUD will sync via the existing
  config-broadcast SSE event in a future revision.
- The HUD only requires the macOS Microphone permission. The app's
  `Info.plist` declares `NSMicrophoneUsageDescription`; macOS prompts
  the user once on first run. Denying it disables voice entirely —
  text via the command bar still works.

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
