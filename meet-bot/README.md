# meet-bot

Container bot that joins a Google Meet session on behalf of an AI assistant so the assistant can listen in (and eventually participate) in the call.

## Role

`meet-bot` runs inside a Linux Docker container with Xvfb, PulseAudio, and Playwright-driven Chromium. The assistant launches a bot instance when the user asks it to attend a meeting; the bot joins the Meet URL as a participant, captures audio through a virtual PulseAudio sink, and streams transcript/events back to the assistant.

This package contains:

- `src/main.ts` — process entry point.
- `src/health.ts` — placeholder health probe invoked by the Dockerfile's `HEALTHCHECK`.
- `Dockerfile` — container image with Xvfb, PulseAudio, Chromium, and Playwright dependencies.
- `__tests__/` — smoke tests that run inside the Bun test runner.

## Status

This is the **skeleton** for the Meet bot. Today it does nothing but boot, log `meet-bot booted`, and exit 0. Real Meet-join, audio capture, and HTTP control-surface logic land in later PRs.

See the plan at `.private/plans/meet-phase-1-listen.md` (repo-local, not committed) for the full rollout — this is PR 1 of 24.

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

The bot interacts with Google Meet through CSS/attribute selectors centralized in
`src/browser/dom-selectors.ts`. Because Meet's web UI drifts without notice,
we commit HTML fixtures in `__tests__/fixtures/` and test every selector
against those fixtures. The shipped fixtures are **plausible approximations**
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
     into `__tests__/fixtures/meet-dom-prejoin.html`.
   - In-meeting: capture the main meeting grid + toolbar + participant panel
     into `__tests__/fixtures/meet-dom-ingame.html`.
   - Chat: open the chat panel, send one test message, then capture the
     panel into `__tests__/fixtures/meet-dom-chat.html`.
   - Scrub any real names, avatars, message content, and meeting IDs from the
     captured HTML — the fixtures are committed to the public repo.
3. **Update `GOOGLE_MEET_SELECTOR_VERSION`** in `src/browser/dom-selectors.ts`
   to today's ISO date (`YYYY-MM-DD`). This records which Meet revision the
   selectors are calibrated against.
4. **Re-run the selector tests**:
   ```bash
   bun test __tests__/dom-selectors.test.ts
   ```
5. **Fix any selector drift.** Selectors marked `// TODO(meet-dom)` are the
   most likely to need adjustment — they are the ones we already knew were
   best-guesses. Update the selector constant, re-run the test, and commit
   the combined fixture-plus-selector refresh in a single PR so the diff is
   reviewable as one unit.

## Manual end-to-end verification against a real Meet call

The automated test suite stubs Docker, Deepgram, and the browser — it can't
catch regressions that only show up against a live Meet UI, a real container
runtime, or live ASR. Before cutting a release that touches the meet
subsystem, run this manual verification loop.

### Prerequisites

- Docker Desktop running on the host (the assistant uses the Docker Engine
  socket at `/var/run/docker.sock`).
- The `vellum-meet-bot:dev` image built locally:
  ```bash
  bash scripts/build-meet-bot-image.sh
  ```
- A Deepgram API key configured via the assistant credential store (the
  session manager looks it up by provider name `"deepgram"`).
- The `meet` feature flag enabled. Either:
  - **Local override** — set `meet` to `true` in
    `~/.vellum/workspace/config.json` under the assistant feature flags
    block, OR
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
   - A new participant with the assistant's configured display name
     appears in the Meet participant list.
   - The bot posts the consent message in Meet chat (the string from
     `services.meet.consentMessage` with `{assistantName}` substituted).
   - Live transcripts of human participants start appearing in the Vellum
     conversation, each prefixed with `[<SpeakerName>]: <text>`.
3. **Verify SSE events in the macOS client.** The "In meeting" status panel
   should reflect live participant and speaker changes as people join,
   leave, or speak.
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

- **Bot never joins** — check the assistant log for
  `meet-session-manager` and `meet-docker-runner` errors. Most common
  causes: missing Deepgram key, stale image, Docker socket not reachable
  from inside the container host.
- **No transcripts in the conversation** — check for `meet-audio-ingest`
  warnings in the log; the bot may be failing to connect to the Unix
  socket or Deepgram may be rejecting the session.
- **Bot doesn't auto-leave on objection** — check for
  `meet-consent-monitor` log lines. The LLM call can time out silently
  if the configured provider is misconfigured; the log will say "LLM
  call failed — staying in the meeting".
- **Artifacts missing after leave** — check the storage writer log
  (`meet-storage-writer`). Common cause: ffmpeg not on the host PATH
  for audio encoding.
