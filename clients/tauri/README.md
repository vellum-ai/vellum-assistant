# Eli HUD (Tauri client)

A cinematic Jarvis-style desktop HUD for the Eli assistant. Lives
alongside the Swift macOS client (`clients/macos/`) and Chrome
extension (`clients/chrome-extension/`); the three clients connect to
the same local gateway and can run concurrently.

## What it does

- **Listener orb** — arc-reactor centerpiece that pulses with mic
  amplitude, color-shifts when a turn opens, and expands while Eli is
  speaking.
- **Transcript pane** — rolling user/assistant feed with streaming
  cursor while the LLM is generating.
- **Status strip** — link state, current model, mode (idle / listening
  / thinking / speaking), and last error.
- **Quick command bar** — type or speak `/tasks`, `/slack`, `/quit`,
  or arbitrary natural-language messages.
- **Always-on voice** (opt-in) — permission-free RMS-based
  voice-activity wake in the WebView, with `/v1/live-voice` WebSocket
  to the gateway, VAD-based endpointing, and barge-in cancellation of
  the assistant's TTS.

## Prerequisites

| Tool         | Version  | Notes                                                    |
| ------------ | -------- | -------------------------------------------------------- |
| Bun          | ≥ 1.1    | Same version pinned in repo `.tool-versions`.            |
| Node         | ≥ 20     | Vite/TS toolchain.                                       |
| Rust         | stable   | `rustup default stable`. Required for `tauri build/dev`. |
| Xcode CLT    | latest   | macOS only — needed for the Tauri WebKit shell.          |

If `cargo --version` fails, install Rust:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Install + run

```bash
cd clients/tauri
bun install
bun run tauri:dev
```

`tauri:dev` boots Vite, watches `src/`, and launches the Tauri shell
window. Use the system tray icon to toggle visibility / always-on-top
or quit.

## Build

```bash
cd clients/tauri
bun run tauri:build
```

Bundles ship into `src-tauri/target/release/bundle/`.

## Hotkey

- The default global hotkey is **`⌘ + ⌥ + Space`** (macOS) — the
  Rust shell registers it via `tauri-plugin-global-shortcut`.
- The system tray icon offers Show/Hide HUD, Toggle always-on-top,
  Quit Eli.

## Environment variables

| Var                       | Required for                       | Notes                                                                                 |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| `LIVEKIT_URL`             | (optional) LiveKit transport       | Default `ws://localhost:7880`. Read by the daemon, not the HUD itself.                |
| `LIVEKIT_API_KEY` / `_SECRET` | LiveKit transport (server-side) | Stored via the daemon credential store, not env-injected at runtime in production.    |
| `DEEPGRAM_API_KEY`        | streaming STT                      | Configured in the daemon credential store. The HUD never sees this key.               |

The always-on wake is an RMS-based voice-activity detector — no
keyword spotter or third-party API key is involved. macOS prompts for
Microphone permission on first launch; denying it disables voice
entirely (the command bar still works for text). The daemon's
server-side STT identifies "Eli, …" prefixes once a turn is open, so
the HUD does not need to recognise the wake word itself.

## Auto-discovery

On launch the HUD parses `~/.vellum.lock.json` (or `~/.vellum.lockfile.json`)
and picks the most-recently-hatched local assistant entry. The
`runtimeUrl` field for cloud assistants is honored verbatim; for local
assistants the gateway port from `resources.gatewayPort` is used.

## Project layout

```
clients/tauri/
├── index.html                    Vite entrypoint with Orbitron + Share Tech Mono fonts
├── src/
│   ├── App.tsx                   Top-level layout
│   ├── main.tsx                  React 19 root
│   ├── components/               Listener orb, transcript pane, status strip, command bar
│   ├── hooks/use-voice-engine.ts Mic/voice/transcript orchestrator
│   ├── services/
│   │   ├── gateway-client.ts     POST /v1/messages
│   │   ├── gateway-events.ts     GET /v1/events SSE subscriber
│   │   ├── live-voice-client.ts  /v1/live-voice WebSocket
│   │   ├── lockfile.ts           ~/.vellum.lock.json discovery
│   │   ├── mic-stream.ts         getUserMedia + 16 kHz int16 PCM resampler
│   │   └── tts-playback.ts       Streaming AudioContext playback
│   ├── styles.css                Tailwind + scanline / hud-shell decorations
│   └── types.ts                  Shared types
└── src-tauri/                    Rust shell (system tray, hotkey, window management)
```

## What's NOT done

- **Settings UI.** Use the existing `vellum-assistant` Settings (or
  `assistant config set …`) to drive `voice.*` config.
- **Multi-instance switching.** Auto-discovery takes the most-recent
  hatched entry. To target a specific assistant, hatch only that one.
- **Authenticated remote runtimes.** The HUD currently assumes the
  gateway is unauthenticated (loopback only). When the user enables
  `runtimeProxyRequireAuth`, the HUD will need to acquire and pass an
  edge token — punted to a follow-up.
- **Client-side keyword wake.** The HUD intentionally relies on
  permission-free RMS-based voice activity detection. A keyword wake
  (Apple Speech, Picovoice, or similar) can come back once the HUD
  ships as a code-signed `.app` — see `AGENTS.md`'s "Voice pipeline"
  section for why dev builds cannot safely call
  `webkitSpeechRecognition`.
