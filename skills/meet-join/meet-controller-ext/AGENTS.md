# meet-controller-ext — Agent Instructions

Chrome extension (Manifest V3) that controls Google Meet on behalf of the
Vellum meet-bot. It runs inside google-chrome-stable, which the bot spawns
as a plain subprocess with `--load-extension=/app/ext` pointed at this
package's `dist/` output. The bot does NOT use CDP or any CDP-based
automation library — Meet's BotGuard rejects CDP-attached joiners, so all
DOM work happens inside this extension and is driven over Chrome Native
Messaging.

## Where it fits

- Lives at `skills/meet-join/meet-controller-ext/` alongside the sibling
  `bot/` and `contracts/` packages.
- The bot's Dockerfile copies the built `dist/` into `/app/ext` and tells
  google-chrome-stable to load it at launch time (via
  `bot/src/browser/chrome-launcher.ts`).
- The extension talks to the bot via Chrome Native Messaging. The bot
  registers a native host manifest (rendered at image-build time by
  `bot/scripts/render-nmh-manifest.ts`) whose `allowed_origins` pin this
  extension's ID, and the service worker `connectNative()`s to it.
- Meet DOM automation — chat send/read, participant scraping, speaker
  detection, virtual-mic priming — runs inside this extension's content
  script (`src/features/*.ts`).

## Build

```
bun install
bun run build
```

Produces `dist/manifest.json`, `dist/background.js`, `dist/content.js`.

## The `key` field

`manifest.json` pins the extension's public key so Chrome computes a
**stable extension ID** across installs. That stable ID is what the
Native Messaging host manifest's `allowed_origins` entry targets.
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
"Refreshing Meet DOM fixtures".
