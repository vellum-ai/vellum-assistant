# meet-bot — Agent Instructions

## Architecture

The meet-bot runs **google-chrome-stable as a plain user-process subprocess** (no CDP, no automation framework). Browser-side DOM work happens inside a sibling Chrome extension package at `../meet-controller-ext/`, loaded via `--load-extension=/app/ext` by `src/browser/chrome-launcher.ts`.

Bot ↔ extension communication flows through Chrome Native Messaging:

- The bot's NMH Unix-socket server (`src/native-messaging/socket-server.ts`) listens on `/run/nmh.sock`.
- The NMH shim (`src/native-messaging/nmh-shim.ts`) is the process Chrome spawns in response to `chrome.runtime.connectNative(...)`. It bridges Chrome's stdin/stdout NMH protocol to the Unix socket.
- Message shapes are declared in `../contracts/native-messaging.ts` (`BotToExtensionMessage` and `ExtensionToBotMessage`, with zod validation on both ends).
- The shim's manifest is rendered at image-build time by `scripts/render-nmh-manifest.ts`, which reads the extension's `manifest.json`, derives the extension ID from its public key, and writes the manifest to `/etc/opt/chrome/native-messaging-hosts/com.vellum.meet.json` with `allowed_origins` set to the derived extension origin.

## What belongs where

- **Bot side** (`src/`):
  - Process boot sequence (`main.ts`): Pulse → Xvfb → NMH socket server → daemon client → Chrome subprocess → `waitForReady` → dispatch `join` → audio capture → HTTP control surface.
  - HTTP control surface for the daemon (`src/control/http-server.ts` — `/leave`, `/send_chat`, `/play_audio`).
  - Daemon client (`src/control/daemon-client.ts` — outbound event ingress).
  - Audio capture (`src/media/audio-capture.ts` — parec piped into a Unix socket the daemon reads from).
  - Audio playback (`src/media/audio-playback.ts` — pacat fed from the daemon's `/play_audio` stream).
  - Native messaging transport (`src/native-messaging/`).
  - Chrome process lifecycle (`src/browser/chrome-launcher.ts`) and Xvfb (`src/browser/xvfb.ts`).
- **Extension side** (`../meet-controller-ext/src/features/`):
  - Join flow (`join.ts`).
  - Participant scraping (`participants.ts`).
  - Speaker indicator (`speaker.ts`).
  - Chat send + inbound chat reader (`chat.ts`).
  - DOM selectors (`../dom/selectors.ts`) and wait helpers (`../dom/wait.ts`).

Do not add Playwright, Puppeteer, or any CDP-based library to this package. The entire reason for the extension architecture is that Google Meet's BotGuard rejects CDP-attached clients before the prejoin renders — see the Phase 1.11 plan at `.private/plans/archived/meet-phase-1-11-chrome-extension.md` for the empirical repro.

## Testing

```bash
cd skills/meet-join/bot
bun install
bunx tsc --noEmit
bun test __tests__/
```

All tests in `__tests__/` must pass. The boot smoke test uses `SKIP_PULSE=1` so it works on macOS developer machines; the `main.test.ts` harness stubs every subsystem (Pulse, Xvfb, Chrome, NMH socket, daemon client, HTTP server) through `BotDeps` injection so the boot and shutdown paths can be verified without touching real processes.
