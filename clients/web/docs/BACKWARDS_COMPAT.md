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

| Module                                                 | Role                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/backwards-compat/`                            | The centralized registry. One file per gated feature, each declaring its own `MIN_VERSION`. `grep` this path to find everything that can eventually be deleted.                                                                                                              |
| `src/lib/backwards-compat/utils.ts`                    | The shared gate primitives: `useAssistantSupports`, `useAssistantScopedSupports`, `assistantSupports`, `assistantScopedSupports`, `whenAssistantVersionKnown`, `whenAssistantVersionKnownFor`. Every gate uses these so semver parsing and pre-release handling are uniform. |
| `src/utils/semver.ts`                                  | Low-level `parseSemver` / `compareParsed` / `comparePreRelease`. No app knowledge — just version-string math.                                                                                                                                                                |
| `src/stores/assistant-identity-store.ts`               | Zustand store holding the active assistant's `{ name, version }`. The source of truth every gate reads.                                                                                                                                                                      |
| `src/assistant/identity.ts`                            | Fetches identity from the assistant's `/identity` endpoint and refreshes it on the SSE `identity_changed` event.                                                                                                                                                             |
| `src/lib/backwards-compat/impersonate-version-flag.ts` | Debug flag for overriding the reported version locally, so a single dev can exercise old and new code paths without juggling installs.                                                                                                                                       |

## How a gate is detected

`utils.ts` exposes these variants, all reading the active assistant
version off the identity store. Pick by call site:

- **`useAssistantSupports(minVersion): boolean`** — the hook. Subscribes
  to the identity store via the `use.version()` selector, so a component
  (or a query whose `enabled`/key depends on it) **re-renders when the
  version flips**. Use this on render paths.
- **`assistantSupports(minVersion): boolean`** — the snapshot. Reads
  `getState().version` once. Safe outside React: event handlers, async
  ops, request builders.
- **`useAssistantScopedSupports(minVersion, ownerAssistantId): boolean`** —
  the assistant-scoped hook. Like `useAssistantSupports`, but additionally
  requires the identity store's version to have been fetched for
  `ownerAssistantId` (the assistant owning the gated surface — a
  transcript, a live voice session), read as a single atomic snapshot.
  Conservative `false` on any mismatch or unknown. Use when the gated
  feature belongs to a specific assistant rather than "whichever assistant
  is active."
- **`assistantScopedSupports(minVersion, ownerAssistantId): boolean`** —
  the non-hook form of the scoped check, for imperative callers. Narrows
  `ownerAssistantId` to `string` on `true`.
- **`whenAssistantVersionKnown(timeoutMs?): Promise<void>`** — resolves
  once the version is non-null (or after a 5 s timeout). Used by write
  paths before reading a snapshot gate; see [Read vs. write
  paths](#read-vs-write-paths).
- **`whenAssistantVersionKnownFor(ownerAssistantId, timeoutMs?): Promise<void>`** —
  the scoped wait. Resolves once the store holds a version fetched **for
  that assistant** (or after the timeout). A scoped write path needs this
  rather than the unscoped wait: across an assistant switch the store
  still carries the outgoing assistant's version, so the unscoped wait
  returns immediately and the following `assistantScopedSupports` read
  races the clear. Resolves immediately for a null owner.

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
6. Add a row to [the registry table](#the-gates).

Keep the old code path until the gate is removed — the gate _is_ the
contract that says it still has callers.

### Choosing `MIN_VERSION`

The comparison is `>=`, so `MIN_VERSION` must name the **first version that
carries the feature**. Both directions of error cost something, and they are
not symmetric:

- **Too low** and an assistant without the feature reads as supported. Loud
  if the missing route 404s; silent and worse if the assistant ignores an
  unknown field or parameter and answers `200` with the wrong shape.
- **Too high** and the feature stays dark for people who do have it, with
  nothing to notice. This is the more common mistake, because the number
  is usually guessed before the release it names exists.

**Prefer a dev floor to a predicted release number.** Set `MIN_VERSION` to
the dev version of the commit that landed the assistant-side change:

```
<base>-dev.<YYYYMMDDHHMM UTC of that commit>.<short sha>
```

That is the exact string `dev-release.yaml` stamps
(`${BASE_VERSION}-dev.$(date -u +%Y%m%d%H%M).${SHORT_SHA}`), and it buys two
things a release number cannot:

- **Nothing has to be predicted.** `versionSupports` compares base versions
  first, so every later release satisfies the floor no matter what it is
  numbered. Guessing "the next scheduled cut" is what
  [`c7e2823`](https://github.com/vellum-ai/vellum-assistant/commit/c7e2823)
  had to fix for the group-icons gate, and a hotfix branching off the latest
  release tag can claim the guessed number without carrying the feature.
- **Dev builds light up.** Dev pre-releases compare AHEAD of the stable
  release with the same base, so anyone running a build cut from `main` after
  that commit gets the new path. Naming an unreleased number instead leaves
  dogfooders on the old path until the cut lands, which is exactly when you
  most want the new one exercised.

Use the commit's timestamp, not `dev.0`. If the assistant-side change landed
after the current version was tagged, dev builds from earlier in the same
window do **not** carry it, and `dev.0` would wrongly light up for them.

A plain release number is still right when the assistant-side change shipped
in a release that already exists. Then it is a fact, not a prediction, and
naming it reads better than a dev string.

Note the self-hosted caveat from [When a gate is
unnecessary](#when-a-gate-is-unnecessary): a same-source setup that runs
unreleased code while reporting the last released `package.json` version
reads as unsupported under any future-versioned floor, dev or not.

## When a gate is unnecessary

A new-endpoint feature may ship **without** a version gate when all of
these hold:

- it is a **read-only query** (no write whose legacy fallback could
  mutate state a newer assistant ignores),
- an older assistant's **404 degrades to exactly the feature-off
  state** — the UI renders identically to "feature absent," with no
  error surfaced to the user. Because React Query keeps the
  last-successful data on error, a read that can succeed before a
  later 404 (e.g. a rollback to a version without the route) must
  **map the 404 to the feature-off value in its `queryFn`** rather
  than let it throw, or the stale success is stranded, and
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

| Gate (`src/lib/backwards-compat/…`)          | `MIN_VERSION`                     | Old behavior (< version)                                                                                                                                                                                                                                                                                 | New behavior (≥ version)                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flag-query-freshness.ts`                    | `0.8.5`                           | 5 s poll interval on feature-flag queries                                                                                                                                                                                                                                                                | Push-based invalidation via `sync_changed` + SSE reconnect (60 s stale, no poll)                                                                                                                                                                                                                               |
| `conversation-id-wire-field.ts`              | `0.8.6`                           | Send `conversationKey` (create-or-lookup) on `POST /v1/messages`                                                                                                                                                                                                                                         | Send strict `conversationId` (direct internal-id lookup)                                                                                                                                                                                                                                                       |
| `server-minted-conversation.ts`              | `0.8.6`                           | Mint a draft UUID locally, send as `conversationKey`                                                                                                                                                                                                                                                     | Omit both id fields; assistant mints the id and echoes it back on first send                                                                                                                                                                                                                                   |
| `avatar-state-manifest.ts`                   | `0.8.7`                           | Infer render mode from workspace sidecar files; write via generic `workspace/write` + `workspace/delete`                                                                                                                                                                                                 | Authoritative `GET /avatar/state` + atomic `POST /avatar/image`                                                                                                                                                                                                                                                |
| `conversation-processing-state.ts`           | `0.8.8`                           | Client-side optimistic mirror (`processingConversationIds`), cleared manually on terminal events                                                                                                                                                                                                         | Trust the server `isProcessing` flag on the conversation row                                                                                                                                                                                                                                                   |
| `llm-context-summary-view.ts`                | `0.8.12`                          | Inline context sections from the list response                                                                                                                                                                                                                                                           | `view=summary` light list + lazy per-log detail via `GET /v1/llm-request-logs/:id/context`                                                                                                                                                                                                                     |
| `vision-attachment-gate.ts`                  | `0.10.0-dev.202606211252.5cf8576` | Client filters images out for non-vision models                                                                                                                                                                                                                                                          | Allow any file type; the image-fallback plugin filters/captions server-side                                                                                                                                                                                                                                    |
| `subagents-reconcile.ts`                     | `0.10.0`                          | Reconcile endpoint not called; recovery relies on live SSE + history only                                                                                                                                                                                                                                | Store resyncs from `GET /subagents/reconcile` on load, reopen, and unknown-id events                                                                                                                                                                                                                           |
| `default-provider-settings.ts`               | `0.10.8`                          | No default-provider marker UI in the Providers modal; status query never fires                                                                                                                                                                                                                           | "Default" tag + "Set as default" via `GET/PUT /v1/config/llm/default-provider`                                                                                                                                                                                                                                 |
| `complete-profile-snapshots.ts`              | `0.10.8`                          | Blank profile fields live-inherit (deep merge); no snapshot copy in the editor                                                                                                                                                                                                                           | Blanks are baked at save time; editor shows the snapshot helper line                                                                                                                                                                                                                                           |
| `use-supports-summarize-up-to-here.ts`       | `0.10.8`                          | No `POST /v1/conversations/summarize`; the per-message "Summarize up to here" hover/long-press action is hidden                                                                                                                                                                                          | Endpoint exists; the action renders and posts to summarize working memory up to a message                                                                                                                                                                                                                      |
| `use-supports-credentials-settings.ts`       | `0.10.8`                          | No credentials-page daemon routes or `credential-requests` mint route; the Settings → Credentials tab is hidden and the page renders NotFound                                                                                                                                                            | Routes exist; the Credentials tab, page, and one-time credential-link actions render                                                                                                                                                                                                                           |
| `use-supports-redacted-credential-chips.ts`  | `0.10.10`                         | Sentinel-shaped transcript text renders as plain text (daemon neither mints nor neutralizes sentinels)                                                                                                                                                                                                   | Assistant-message sentinels upgrade to redacted-credential reveal chips                                                                                                                                                                                                                                        |
| `use-supports-noninteractive-voice-turns.ts` | `0.11.0`                          | Voice turns can raise `oauth_connect` surfaces mid-call; the voice room renders its own reachable connect card                                                                                                                                                                                           | Voice turns force `supportsDynamicUi: false` (no mid-call surfaces); the room card stays hidden                                                                                                                                                                                                                |
| `channel-access-controls.ts`                 | `0.11.0`                          | Channel list renders without Assistant Access controls (no tier badges, picker, or legend card)                                                                                                                                                                                                          | Two-level Assistant Access picker on the Channels tab, backed by the assistant-side collapse contract                                                                                                                                                                                                          |
| `subagent-detail-self-lookup.ts`             | `0.11.1`                          | Missed-spawn stub renders from live stream events only (generic label, no history backfill); detail fetch withheld when only the parent conversation id is known. Includes 0.11.0, which self-resolves from live manager state alone and so still misreads an evicted subagent                           | `GET /subagents/:id` self-resolves the subagent's own conversation from live state or its durable row (parent id is a fallback) and returns `label` / `parentToolUseId`, so a missed-spawn stub hydrates full detail                                                                                           |
| `use-supports-image-gen-vellum-provider.ts`  | `0.11.0`                          | Vellum image-gen selection persists as legacy `{ mode: "managed" }` with no provider field                                                                                                                                                                                                               | Save path writes `provider: "vellum"`, which the config enum accepts                                                                                                                                                                                                                                           |
| `use-supports-new-chat-plugins.ts`           | `0.12.0`                          | New-chat plugin picker hidden; the send path omits the per-chat plugin set (older daemons ignore it)                                                                                                                                                                                                     | Picker renders and the send path includes the per-chat plugin set the daemon applies                                                                                                                                                                                                                           |
| `use-supports-inchat-plugin-edit.ts`         | `0.12.0`                          | In-chat plugin pill hidden; the conversation GET omits `enabledPlugins` so per-chat scope is unreadable                                                                                                                                                                                                  | Pill renders the conversation's plugin scope and edits it via `PUT /conversations/:id/enabledplugins`                                                                                                                                                                                                          |
| `use-supports-group-filter.ts`               | `0.11.2-dev.202608052136.dce970c` | `GET /v1/conversations` does not know the `groupId` parameter. Being unrecognized it is ignored, not rejected, so the request answers 200 with the entire unfiltered list. Sidebar sections derive their rows from the foreground page they are handed instead of querying for their own members         | The filter is honored, so a section fetches exactly its own rows (including members that sort many pages deep). Scoped to the owning assistant, so a version held for the outgoing assistant cannot authorize a filtered fetch against the incoming one                                                        |
| `use-supports-native-origin-filter.ts`       | `0.11.2-dev.202608070222.ef06e94` | `originChannel=vellum` compiles to a strict equality, so it matches only rows explicitly stamped `'vellum'` and misses every row still unattributed (`origin_channel` is NULL at insert so an inbound message can claim it). The Grouped view's Chats card derives its rows from the loaded list instead | `vellum` matches NULL as well, so Chats fetches everything no channel claimed. Scoped to the owning assistant, and strictly later than the group-filter floor, so anything passing it also honors `groupId`                                                                                                    |
| `use-supports-web-presence.ts`               | `0.11.4-dev.202608192259.e726ce0` | No web-presence POST route; mount, lifecycle-edge, focused-conversation, SSE-reopen, and reconciliation reports are disabled                                                                                                                                                                             | `POST /v1/assistants/{assistant_id}/clients/web-presence` exists; the browser reports visibility and focused conversation on mount, lifecycle edges, focused changes, SSE reopen, and reconciliation                                                                                                           |
| `use-supports-resource-pressure-status.ts`   | `0.11.5`                          | No `GET /v1/resource-pressure/status` route; the resource-pressure monitor (a hand-rolled poller outside React Query's no-retry policy) stays disabled so it never 404s on mount, poll ticks, and app resume                                                                                             | Route exists; the monitor polls it for platform-hosted assistants and feeds the resource-pressure banner                                                                                                                                                                                                       |
| `ingress-status-gate.ts`                     | `0.11.6`                          | No `GET integrations/ingress/status` route, so the Pair-a-device card keeps its pre-probe behavior: tunnel state is inferred from the platform's `ingress_url` (refreshed only on `vellum login`) and no status row renders                                                                              | Route exists; the card queries real daemon-side tunnel health (healthy, unreachable, foreign, stopped, unconfigured), prefills the public URL from the daemon, and re-probes on `app.resume`. Assistant-scoped, so a version held for the outgoing assistant cannot authorize a probe against the incoming one |
| `watch-sessions.ts`                          | `0.11.4-dev.202608212020.70f2864` | No `/v1/watch/stream` route, so the upgrade is refused. Watch is inert: the press opens no socket, the microphone stays closed, and the companion surface draws what it draws with no session running. Without the gate the press flips `watching` first and fails the handshake after, lighting the capture ring for a session that never existed | The stream opens and the session runs. Scoped to the assistant the session is bound to, so a version fetched for the outgoing assistant cannot authorize a capture against the incoming one |
| `watch-retro-completion.ts`                  | `0.11.4-dev.202608212020.70f2864` | No `watch_retro_completed` event, so nothing can settle the wait a stopped session opens. A stop returns the companion straight to resting, as it did before the summary existed. The same floor as the watch stream's, because the route and the announcement landed on `main` in one merge, so no build serves a session it cannot announce | The stop opens the pending wait and the runtime's announcement on the assistant's event stream ends it. Scoped to the assistant the session is bound to, since the announcement arrives on that assistant's stream |

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
- **Cold-boot landing's one-row read**:
  `src/domains/chat/utils/landing-conversation.ts` asks
  `GET /v1/conversations?foregroundOnly=true&limit=1` for the newest
  conversation the user can open. An assistant that predates the parameter
  ignores it and answers 200 with the newest row of the unfiltered listing,
  the "silent superset" that normally forces a version gate. Here the client
  can tell: it asked for a foreground row, so a returned row that fails
  `isStoredConversationSelectable` proves the filter was not applied, and the
  landing falls back to paging the unfiltered list itself. A gate would also
  be read before the identity fetch hydrates the version on most cold boots
  and send them all down the paged path. The paged fallback is the legacy
  branch: delete it once no supported assistant predates the parameter.
- **Pending-question reconcile**:
  `src/domains/chat/pending-question.ts` decides whether the ask_question card
  should be raised or retired from the `pendingQuestion` key on
  `GET /v1/pending-interactions`. An assistant that carries the key reports
  either the outstanding prompt or `null`; one that predates it omits the key
  entirely, and `undefined` is read as "no opinion" so the legacy restore (the
  `pendingQuestion` marker stamped on a history tool call) keeps the card. The
  distinction has to survive: reading a missing key as "nothing outstanding"
  would retire live prompts against every older assistant. A version gate is
  the wrong instrument here for the same reason as the landing read above, and
  because the reconcile runs on the first committed snapshot, which is usually
  before the identity fetch hydrates a version to compare. Delete the marker
  branch (and `extractWirePendingQuestion` with it) once no supported assistant
  predates the key.
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
