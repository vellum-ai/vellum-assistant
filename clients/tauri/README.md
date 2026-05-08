# Eli HUD (Tauri client)

A cinematic Jarvis-style desktop HUD for the Eli assistant. Lives
alongside the Swift macOS client (`clients/macos/`) and Chrome
extension (`clients/chrome-extension/`); the three clients connect to
the same local gateway and can run concurrently.

## What it does

- **Listener orb** — arc-reactor centerpiece that pulses with mic
  amplitude, color-shifts when the wake word fires, and expands while
  Eli is speaking.
- **Transcript pane** — rolling user/assistant feed with streaming
  cursor while the LLM is generating.
- **Status strip** — link state, current model, mode (idle / listening
  / thinking / speaking), and last error.
- **Quick command bar** — type or speak `/tasks`, `/slack`, `/quit`,
  or arbitrary natural-language messages.
- **Always-on voice** (opt-in) — Picovoice Porcupine wake word in the
  WebView, with `/v1/live-voice` WebSocket to the gateway, VAD-based
  endpointing, and barge-in cancellation of the assistant's TTS.

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
| `PICOVOICE_ACCESS_KEY`    | wake-word detection                | Free tier: <https://console.picovoice.ai/>. Without it, wake word disables silently.  |
| `LIVEKIT_URL`             | (optional) LiveKit transport       | Default `ws://localhost:7880`. Read by the daemon, not the HUD itself.                |
| `LIVEKIT_API_KEY` / `_SECRET` | LiveKit transport (server-side) | Stored via the daemon credential store, not env-injected at runtime in production.    |
| `DEEPGRAM_API_KEY`        | streaming STT                      | Configured in the daemon credential store. The HUD never sees this key.               |

The HUD never bundles secrets. `PICOVOICE_ACCESS_KEY` is read on launch
by the Rust command `picovoice_access_key` and only handed to
`@picovoice/porcupine-web` if it's non-empty.

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
│   │   ├── tts-playback.ts       Streaming AudioContext playback
│   │   └── wake-word-client.ts   @picovoice/porcupine-web wrapper
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
- **Custom wake-word training.** Only the built-in Picovoice keywords
  are wired in the default config. Users with a Picovoice Console
  license can switch `voice.wakeWord.keywords[].source.kind` to
  `file` and point at a `.ppn` once the daemon's wake-word config
  surfaces this through the broadcast SSE event.
