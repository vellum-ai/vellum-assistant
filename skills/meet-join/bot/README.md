# meet-bot

Container bot that joins a Google Meet session on behalf of an AI assistant so the assistant can listen in (and eventually participate) in the call.

## Role

`meet-bot` runs inside a Linux Docker container with Xvfb, PulseAudio, and a Chrome extension driving google-chrome-stable as a plain subprocess. The assistant launches a bot instance when the user asks it to attend a meeting; the bot joins the Meet URL as a participant, captures audio through a virtual PulseAudio sink, and streams transcript/events back to the assistant.

Why not CDP / a headless-automation library? Google Meet's BotGuard detects CDP attachment (`--remote-debugging-port`, `--enable-automation`, etc.) and rejects anonymous joiners before the prejoin UI renders. We therefore launch `google-chrome-stable` as a plain user process with `--load-extension=/app/ext`, and drive Meet from inside a bundled Chrome extension (`../meet-controller-ext/`). Bot ↔ extension communication flows over a Unix-socket-backed Chrome Native Messaging host.

This package contains:

- `src/main.ts` — process entry point. Boots PulseAudio, Xvfb, the NMH socket server, then spawns Chrome with the controller extension loaded. Waits for the extension's `ready` handshake, dispatches the `join` command, and stands up the HTTP control surface.
- `src/browser/chrome-launcher.ts` — spawns `google-chrome-stable` as a plain subprocess with `--load-extension=/app/ext`. No CDP.
- `src/browser/xvfb.ts` — virtual-display manager for headful Chrome.
- `src/native-messaging/` — Chrome Native Messaging host: socket server + shim process that Chrome runs in response to `chrome.runtime.connectNative(...)`.
- `src/control/` — HTTP control surface (`/leave`, `/send_chat`, `/play_audio`), bot lifecycle state, daemon client.
- `src/media/` — PulseAudio bootstrap, audio capture (parec → daemon socket), audio playback (pacat).
- `src/health.ts` — placeholder health probe invoked by the Dockerfile's `HEALTHCHECK`.
- `Dockerfile` — container image with Xvfb, PulseAudio, google-chrome-stable, ffmpeg. The extension is built inside the image and installed at `/app/ext/`.
- `__tests__/` — tests that run inside the Bun test runner.

Browser-side DOM work (join flow, participant scraping, speaker indicator, chat send/read) lives in `../meet-controller-ext/src/features/`. Events flow bot → extension as `BotToExtensionMessage` and extension → bot as `ExtensionToBotMessage` (see `../contracts/native-messaging.ts`).

## Development

```bash
cd meet-bot
bun install
bunx tsc --noEmit
bun test __tests__/boot.test.ts
```

To build the container image (requires Docker):

```bash
./scripts/build-meet-bot-image.sh
```

## Refreshing Meet DOM fixtures

The extension interacts with Google Meet through CSS/attribute selectors centralized in
`skills/meet-join/meet-controller-ext/src/dom/selectors.ts`. Because Meet's web UI drifts without
notice, we commit HTML fixtures in `skills/meet-join/meet-controller-ext/src/dom/__tests__/fixtures/`
and test every selector against those fixtures. The shipped fixtures are **plausible approximations**
of Meet's DOM authored by hand — they exercise the selectors but are not
literal snapshots.

When Meet's UI changes (failing tests, broken bot behavior in production, or
just on a scheduled cadence), a human developer should refresh the fixtures
against a live Meet session. The refresh procedure:

1. **Join a real Google Meet** with at least two participants (one speaking,
   one sharing screen if the presenter indicator needs verification). Use a
   throwaway test meeting, not a live customer call.
2. **Capture outer-HTML** of the relevant DOM regions via Chrome DevTools:
   - Prejoin: right-click the prejoin panel root → Inspect → copy outer HTML
     into `skills/meet-join/meet-controller-ext/src/dom/__tests__/fixtures/meet-dom-prejoin.html`.
   - In-meeting: capture the main meeting grid + toolbar + participant panel
     into `.../fixtures/meet-dom-ingame.html`.
   - Chat: open the chat panel, send one test message, then capture the
     panel into `.../fixtures/meet-dom-chat.html`.
   - Scrub any real names, avatars, message content, and meeting IDs from the
     captured HTML — the fixtures are committed to the public repo.
3. **Update `GOOGLE_MEET_SELECTOR_VERSION`** in
   `skills/meet-join/meet-controller-ext/src/dom/selectors.ts` to today's ISO
   date (`YYYY-MM-DD`). This records which Meet revision the selectors are
   calibrated against.
4. **Re-run the selector tests**:
   ```bash
   cd skills/meet-join/meet-controller-ext && bun test src/dom/__tests__/selectors.test.ts
   ```
5. **Fix any selector drift.** Selectors marked `// TODO(meet-dom)` are the
   most likely to need adjustment — they are the ones we already knew were
   best-guesses. Update the selector constant, re-run the test, and commit
   the combined fixture-plus-selector refresh in a single PR so the diff is
   reviewable as one unit.

## Manual end-to-end verification against a real Meet call

The automated test suite stubs Docker, the configured STT provider, and the
browser — it can't catch regressions that only show up against a live Meet UI,
a real container runtime, or live ASR. Before cutting a release that touches
the meet subsystem, run this manual verification loop.

### Prerequisites

- Docker Desktop running on the host (the assistant uses the Docker Engine
  socket at `/var/run/docker.sock`).
- The `vellum-meet-bot:dev` image built locally:
  ```bash
  bash scripts/build-meet-bot-image.sh
  ```
- An STT provider configured in `services.stt.provider` (Deepgram, Google
  Gemini, or OpenAI Whisper) with its credentials available in the assistant's
  credential store. The assistant resolves the provider and its credentials at
  meeting-start time; the bot itself does not see STT credentials.
- The `meet` feature flag enabled. Either:
  - **Local override** — set `meet` to `true` in
    `~/.vellum/workspace/config.json` (or `$VELLUM_WORKSPACE_DIR/config.json`
    in Docker mode) under the assistant feature flags block, OR
  - **LaunchDarkly** — flip the `meet` flag on for your platform user.
- A throwaway Google Meet URL with at least one other human participant so
  you can watch the bot behavior live.

### Procedure

1. **Ask the assistant to join.** From any conversation in the Vellum
   macOS app:
   ```
   meet_join https://meet.google.com/xxx-yyyy-zzz
   ```
   The assistant should respond with the session descriptor (meetingId,
   container id, bot base URL).
2. **Observe the bot join.** Expected behavior within ~30 seconds:
   - `main.ts` spawns google-chrome-stable with `--load-extension=/app/ext`.
     The extension's background worker opens a Unix-socket-backed native
     messaging connection back to the bot process, then the extension's
     content script navigates the Meet prejoin UI.
   - A new participant with the assistant's configured display name
     appears in the Meet participant list.
   - The bot posts the consent message in Meet chat (the string from
     `services.meet.consentMessage` with `{assistantName}` substituted).
   - Live transcripts of human participants start appearing in the Vellum
     conversation, each prefixed with `[<SpeakerName>]: <text>`.
3. **Verify SSE events in the macOS client.** The "In meeting" status panel
   should reflect live participant and speaker changes as people join,
   leave, or speak. All of those events originate inside the extension and
   flow back to the daemon via NMH → socket server → daemon client.
4. **Exercise the auto-leave path.** Ask another participant to type
   `please leave` (or any of the configured `objectionKeywords`) in Meet
   chat. Expected: the bot leaves the meeting within ~5 seconds and
   the macOS status panel transitions out of "in meeting".
5. **Inspect on-disk artifacts.** After the bot leaves, the workspace
   directory should contain the meeting's artifact tree:
   ```bash
   ls -la ~/.vellum/workspace/meets/<meetingId>/
   ```
   Expected files:
   - `audio.opus` — Opus-encoded audio, non-empty.
   - `transcript.jsonl` — one JSON line per final transcript chunk.
   - `segments.jsonl` — one JSON line per DOM-reported speaker span.
   - `participants.json` — full final participant snapshot.
   - `meta.json` — summary record written on the `lifecycle:left` event.
     Open each file and spot-check that it's well-formed and reflects the
     meeting content (no empty transcripts when people were clearly
     speaking, no missing speaker names that were visible in the Meet UI).
6. **Verify graceful daemon shutdown.** Join a meeting, wait for the bot
   to stabilize, then kill the assistant with `SIGTERM` (the Vellum CLI's
   stop flow, or `kill <daemon-pid>`). Expected: the bot leaves the
   meeting cleanly (no leftover participant in the Meet UI) and the
   container is removed (`docker ps -a | grep vellum-meet-` should be
   empty) within the 15-second shutdown budget.

### Failure triage

- **Bot never joins** — the most common causes are extension load failures
  or native-messaging misconfiguration:
  - Check extension load errors by inspecting the Chrome debug log:
    ```bash
    docker exec <container> cat /tmp/chrome-profile-*/chrome_debug.log
    ```
    (may not always exist; if it does, look for `Extension error:` lines).
  - Confirm the native-messaging host manifest exists at
    `/etc/opt/chrome/native-messaging-hosts/com.vellum.meet.json` and the
    extension ID inside that manifest's `allowed_origins` matches the ID
    derived from the extension's public key.
  - Confirm the NMH shim (`src/native-messaging/nmh-shim.ts`) is executable
    inside the container (`chmod +x` is applied at image build time but a
    volume mount can hide it).
  - Also check the assistant log for `meet-session-manager` and
    `meet-docker-runner` errors: missing STT provider credentials, stale
    image, or Docker socket not reachable from inside the container host.
- **Extension failed to connect to native host** — the most specific flavor
  of "bot never joins":
  - Verify `/etc/opt/chrome/native-messaging-hosts/com.vellum.meet.json`
    contains `{"path": "/app/bot/src/native-messaging/nmh-shim.ts", ...}`
    pointing at an existing, executable file.
  - Verify the manifest's `allowed_origins` includes the extension's origin
    (`chrome-extension://<ID>/`). The ID is derived deterministically from
    the extension's public key in its `manifest.json` — `render-nmh-manifest.ts`
    runs at image-build time to keep the two in sync.
- **No transcripts in the conversation** — check for `meet-audio-ingest`
  warnings in the log; the bot may be failing to connect to the Unix
  socket or the STT provider may be rejecting the session. (The audio
  pipeline is unchanged by the extension migration — audio flows parec →
  socket → daemon.)
- **Bot doesn't auto-leave on objection** — check for
  `meet-consent-monitor` log lines on the daemon side. The LLM call can
  time out silently if the configured provider is misconfigured; the log
  will say "LLM call failed — staying in the meeting". (The consent
  monitor runs on the daemon, not the bot — unchanged by the extension
  migration.)
- **Artifacts missing after leave** — check the storage writer log
  (`meet-storage-writer`). Common cause: ffmpeg not on the host PATH
  for audio encoding.
