# meet-controller-ext — Agent Instructions

Chrome extension (Manifest V3) that controls Google Meet on behalf of the
Vellum meet-bot. It runs inside the same Chromium the bot drives via
Playwright; the bot launches Chromium with `--load-extension=/app/ext`
pointed at this package's `dist/` output (wiring added in PR 13).

## Where it fits

- Lives at `skills/meet-join/meet-controller-ext/` alongside the sibling
  `bot/` and `contracts/` packages.
- The bot's Dockerfile copies the built `dist/` into `/app/ext` and tells
  Chromium to load it at launch time (PR 13).
- The extension talks to the bot via Chrome Native Messaging: the bot
  registers a native host manifest (PR 6) whose `allowed_origins` pin this
  extension's ID, and the service worker `connectNative()`s to it (PR 8).
- Meet DOM automation (chat, participants, speaker detection, virtual-mic
  priming) moves from Playwright page-world scripts into this extension's
  content script across PRs 9-12.

## Build

```
bun install
bun run build
```

Produces `dist/manifest.json`, `dist/background.js`, `dist/content.js`.

## The `key` field

`manifest.json` pins the extension's public key so Chromium computes a
**stable extension ID** across installs. That stable ID is what the
Native Messaging host manifest's `allowed_origins` entry targets (PR 6).
Regenerating the key rotates the ID and requires a matching NMH update.

- The private key is **not** committed to the repo. Only the base64
  DER-encoded public key belongs in `manifest.json`.
- To derive the extension ID from the public key: SHA-256 the DER bytes,
  take the first 32 hex chars, then map `0..f` to `a..p`.

## Isolation rule

This package must **not** import from `assistant/`, `gateway/`, or from
the sibling bot's `src/`. It is the browser-side peer of the bot and
communicates with the bot only through the Native Messaging port, using
message shapes defined in `../contracts/`. Treat contracts as the sole
shared surface between bot and extension.

## Google Meet DOM selectors

The centralized selector module lives at `src/dom/selectors.ts` and is the
single source of truth for every CSS/attribute selector the content script
uses against Google Meet's web UI. Matching HTML fixtures live under
`src/dom/__tests__/fixtures/` and are exercised by
`src/dom/__tests__/selectors.test.ts` — if a selector is added without a
matching fixture assertion, CI fails.

When Meet's DOM drifts, refresh the fixtures and bump
`GOOGLE_MEET_SELECTOR_VERSION` in `selectors.ts`. The step-by-step refresh
procedure is documented in `skills/meet-join/bot/README.md` §
"Refreshing Meet DOM fixtures" for now; that README will relocate alongside
this package later in the migration.
