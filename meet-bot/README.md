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
