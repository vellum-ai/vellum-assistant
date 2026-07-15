# Web App — Backwards Compatibility

How the web client copes with talking to an assistant that may be running an older version
than the bundle the browser just loaded.

See also [`clients/web/AGENTS.md`](../AGENTS.md), the umbrella
[`CONVENTIONS.md`](./CONVENTIONS.md), and
[`STATE_MANAGEMENT.md`](./STATE_MANAGEMENT.md).

---

## The problem

The web app **always serves the latest bundle** from Vellum's
infrastructure. The assistant side, however, runs separately and can be at
**any version the user happens to have installed**. New web features ship
continuously, well before every assistant in the wild has upgraded. So on
any given page load the browser may be newer than the assistant it's
connected to — and a feature that assumes a new endpoint, wire field, or
event shape will break against an older assistant.

The fix is **version gating**: the web app detects the connected
assistant's version and either lights up the new code path or falls back
to whatever the assistant understood before.

This is explicitly a **temporary** layer. Every gate is delete-on-sight
the day we solve serving a matching web bundle per assistant version. To
keep that future deletion tractable, all the "if assistant < X.Y.Z, do
the old thing" logic lives in one place. We will soon also have telemetry
informing us of live clients in use so we can delete old cold paths incrementally.

## Where it lives

| Module                                                 | Role                                                                                                                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/backwards-compat/`                            | The centralized registry. One file per gated feature, each declaring its own `MIN_VERSION`. `grep` this path to find everything that can eventually be deleted.                     |
| `src/lib/backwards-compat/utils.ts`                    | The shared gate primitives: `useAssistantSupports`, `assistantSupports`, `whenAssistantVersionKnown`. Every gate uses these so semver parsing and pre-release handling are uniform. |
| `src/utils/semver.ts`                                  | Low-level `parseSemver` / `compareParsed` / `comparePreRelease`. No app knowledge — just version-string math.                                                                       |
| `src/stores/assistant-identity-store.ts`               | Zustand store holding the active assistant's `{ name, version }`. The source of truth every gate reads.                                                                             |
| `src/assistant/identity.ts`                            | Fetches identity from the assistant's `/identity` endpoint and refreshes it on the SSE `identity_changed` event.                                                                    |
| `src/lib/backwards-compat/impersonate-version-flag.ts` | Debug flag for overriding the reported version locally, so a single dev can exercise old and new code paths without juggling installs.                                              |

## How a gate is detected

`utils.ts` exposes three variants, all reading the active assistant
version off the identity store. Pick by call site:

- **`useAssistantSupports(minVersion): boolean`** — the hook. Subscribes
  to the identity store via the `use.version()` selector, so a component
  (or a query whose `enabled`/key depends on it) **re-renders when the
  version flips**. Use this on render paths.
- **`assistantSupports(minVersion): boolean`** — the snapshot. Reads
  `getState().version` once. Safe outside React: event handlers, async
  ops, request builders.
- **`whenAssistantVersionKnown(timeoutMs?): Promise<void>`** — resolves
  once the version is non-null (or after a 5 s timeout). Used by write
  paths before reading a snapshot gate; see [Read vs. write
  paths](#read-vs-write-paths).

### Version semantics

The comparison in `supportsVersion()` has a few deliberate quirks worth
knowing before you add a gate:

- **Unknown version returns `false`.** The version starts `null` and
  hydrates asynchronously after identity fetches. Until then, every gate
  reports "not supported" and the app falls back to the legacy path. That
  fallback must be something _any_ assistant understands.
- **Pre-release suffixes on the patch are ignored.** `0.8.5-rc.1` counts
  as `0.8.5`, so RC/beta/alpha testers get the new path the moment the
  patch version bumps.
- **`dev` builds are treated as AHEAD of the stable release with the same
  base** — the opposite of strict semver. A build like
  `0.10.0-dev.202606211252.5cf8576` contains unreleased commits on top of
  `0.10.0`, so it's considered _newer_ than `0.10.0` stable. Two dev
  builds with the same base compare by their pre-release string, which
  encodes a `dev.YYYYMMDDHHMM.sha` timestamp. This lets a gate target a
  specific dev build by passing the exact dev version string as
  `minVersion` (the [vision attachment gate](#the-gates) does this).
- **Unparseable versions (either side) return `false`.**

## Read vs. write paths

The snapshot `assistantSupports()` collapses "version unknown" and
"version known-but-old" into the same `false`. That's **safe for reads**:
a read that falls back to a universally-understood legacy route is
harmless even if it briefly runs before the version hydrates.

It is **not safe for writes** whose legacy fallback mutates state in a way
a newer assistant would ignore — you could send the old-shaped write to a
new assistant just because the version hadn't loaded yet. Those paths
`await whenAssistantVersionKnown()` first, then read the gate against a
resolved version instead of the conservative `false`-on-unknown default.
The avatar upload path is the canonical example (`assistant/avatar-api.ts`
awaits `resolveSupportsAvatarStateManifest()` before branching).

## Adding a gate

1. Create `src/lib/backwards-compat/<feature>.ts`.
2. Declare a module-level `MIN_VERSION` and a doc comment describing the
   **old vs. new** behavior — this is what someone deleting the gate later
   reads to confirm the old path is dead.
3. Export a small, named helper (`supportsX` / `useSupportsX`) that wraps
   `assistantSupports(MIN_VERSION)` or `useAssistantSupports(MIN_VERSION)`.
   Don't call the gate primitives inline at the use site — the named
   wrapper keeps the gate greppable and gives the boolean a meaning.
4. For a write path, expose an async `resolveSupportsX()` that awaits
   `whenAssistantVersionKnown()` first.
5. Add a colocated `<feature>.test.ts`.

Keep the old code path until the gate is removed — the gate _is_ the
contract that says it still has callers.

## When a gate is unnecessary

A new-endpoint feature may ship **without** a version gate when all of
these hold:

- it is a **read-only query** (no write whose legacy fallback could
  mutate state a newer assistant ignores),
- an older assistant's **404 degrades to exactly the feature-off
  state** — the UI renders identically to "feature absent," with no
  error surfaced to the user, and
- the request stays quiet under failure: the app QueryClient **never
  retries 4xx** (see `providers.tsx`), and the query disables refetch
  triggers that would re-issue the failing request (e.g.
  `refetchOnWindowFocus: false` when changes only arrive via
  `sync_changed` invalidations).

The cost of gatelessness is a single, unretried 404 per trigger from
assistants that predate the endpoint. The benefit is that same-source
self-hosted setups — where the daemon runs unreleased code but reports
the last released `package.json` version, so every future-versioned
gate reads as "unsupported" — get the feature without debug overrides.
The workspace-theme query (`useWorkspaceTheme`) is the reference
example. Writes, and reads whose fallback diverges from feature-off,
still gate.

## The gates

Each module owns one feature's old/new split. Current registry:

| Gate (`src/lib/backwards-compat/…`) | `MIN_VERSION`                     | Old behavior (< version)                                                                                 | New behavior (≥ version)                                                                   |
| ----------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `flag-query-freshness.ts`           | `0.8.5`                           | 5 s poll interval on feature-flag queries                                                                | Push-based invalidation via `sync_changed` + SSE reconnect (60 s stale, no poll)           |
| `conversation-id-wire-field.ts`     | `0.8.6`                           | Send `conversationKey` (create-or-lookup) on `POST /v1/messages`                                         | Send strict `conversationId` (direct internal-id lookup)                                   |
| `server-minted-conversation.ts`     | `0.8.6`                           | Mint a draft UUID locally, send as `conversationKey`                                                     | Omit both id fields; assistant mints the id and echoes it back on first send               |
| `avatar-state-manifest.ts`          | `0.8.7`                           | Infer render mode from workspace sidecar files; write via generic `workspace/write` + `workspace/delete` | Authoritative `GET /avatar/state` + atomic `POST /avatar/image`                            |
| `conversation-processing-state.ts`  | `0.8.8`                           | Client-side optimistic mirror (`processingConversationIds`), cleared manually on terminal events         | Trust the server `isProcessing` flag on the conversation row                               |
| `llm-context-summary-view.ts`       | `0.8.12`                          | Inline context sections from the list response                                                           | `view=summary` light list + lazy per-log detail via `GET /v1/llm-request-logs/:id/context` |
| `vision-attachment-gate.ts`         | `0.10.0-dev.202606211252.5cf8576` | Client filters images out for non-vision models                                                          | Allow any file type; the image-fallback plugin filters/captions server-side                |
| `default-provider-settings.ts`      | `0.10.8`                          | No default-provider marker UI in the Providers modal; status query never fires                           | "Default" tag + "Set as default" via `GET/PUT /v1/config/llm/default-provider`             |
| `complete-profile-snapshots.ts`     | `0.10.8`                          | Blank profile fields live-inherit (deep merge); no snapshot copy in the editor                            | Blanks are baked at save time; editor shows the snapshot helper line                        |
| `use-supports-redacted-credential-chips.ts` | `0.11.0`                  | Sentinel-shaped transcript text renders as plain text (daemon neither mints nor neutralizes sentinels)   | Assistant-message sentinels upgrade to redacted-credential reveal chips                     |
| `use-supports-noninteractive-voice-turns.ts` | `0.11.0`                 | Voice turns can raise `oauth_connect` surfaces mid-call; the voice room renders its own reachable connect card | Voice turns force `supportsDynamicUi: false` (no mid-call surfaces); the room card stays hidden |

When you delete a row here, also delete its module, its test, and the now-dead
legacy branch at the call site.

## Related compatibility seams (outside the registry)

A few backwards-compat concerns don't fit the version-gate shape and live
with the code they protect:

- **SSE event parsing** — `src/lib/streaming/event-parser.ts` accepts both
  the enveloped event shape of 0.8.5+
  (`{ id, conversationId, seq, emittedAt, message }`) and the flat legacy
  shape (`{ type, … }`), wrapping the legacy form in a synthetic envelope
  so downstream callers never see the difference.
- **Message normalization** — `src/domains/chat/api/messages.ts`
  reconstructs the unified `contentBlocks` discriminated union from the
  pre-0.8.8 positional arrays (`textSegments`, `thinkingSegments`,
  `toolCalls`, `surfaces`, `attachments`, `contentOrder`) when an assistant
  omits `contentBlocks`, so the renderer only ever deals with one shape.
- **Electron / Capacitor bridge** — `src/runtime/is-electron.ts` declares
  `window.vellum` with **optional capability groups** (`helper?`,
  `featureFlags?`, `diagnostics?`, …). Consumers guard on presence
  (`window.vellum?.helper?.hotkey?.fnPushToTalk()`), so a newer renderer
  running against an older native shell no-ops instead of crashing. This
  is capability detection rather than version comparison.
- **localStorage migrations** — `src/utils/storage-migration.ts` performs
  one-time, idempotent key renames (legacy keys → the `vellum:` / `device:`
  namespaces). Run at startup before any store reads localStorage. This is
  client-internal versioning, not assistant compatibility.

## Testing against an old (or new) assistant

You don't need multiple assistant installs. The impersonation flag
overrides the version every gate sees:

```js
// In the browser console (debug builds expose window._vellumDebug.flags):
impersonateVersion("0.8.6"); // pretend the assistant is 0.8.6, then reload
impersonateVersion(null); // clear the override, then reload
impersonateVersion(); // log the current override, no reload
```

It persists to `localStorage` (`vellum:debug:impersonateAssistantVersion`)
and reloads the page so the whole app — version-derived constants, SSE
handlers, every gate — sees one consistent version. The identity store's
`setIdentity` consults the override and substitutes it, so individual gates
never need to know the flag exists.
