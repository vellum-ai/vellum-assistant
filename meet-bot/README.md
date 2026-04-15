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
