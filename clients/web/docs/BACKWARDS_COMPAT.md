# Web App: Backwards Compatibility (legacy)

> **Legacy. Do not add a version gate.** New web features do not branch on
> the assistant's version. The rule is in [No assistant-version
> gating](../AGENTS.md#no-assistant-version-gating). Read this document to
> understand a gate that already exists, so that you can delete it.

See also the umbrella [`CONVENTIONS.md`](./CONVENTIONS.md) and
[`STATE_MANAGEMENT.md`](./STATE_MANAGEMENT.md).

---

## Why the gates exist, and why we stopped adding them

A release cuts the web bundle and the assistant from the same commit, and a
platform-hosted assistant moves with the release. Delivery is looser than
that: the deployed SPA is latest-only (one bucket per environment, with
`index.html` served `no-cache`), a self-hosted assistant upgrades when its
owner upgrades it, and the desktop shell carries a frozen renderer beside a
CLI that floats to an npm dist-tag. A bundle can therefore still meet an
assistant built from a different commit, and a feature that assumes a new
endpoint, wire field, or event shape can meet an assistant that does not
serve it.

`src/lib/backwards-compat/` was the answer to that. Each feature declared a
`MIN_VERSION`, took the new path at or above it, and fell back to whatever
the older assistant understood below it.

What retired the mechanism is the direction it fails in. A `MIN_VERSION` has
to be written before the release it names exists, so it is a prediction, and
a wrong prediction disables the feature for everyone with no signal at all.
One gate pinned `0.12.0` for a route that shipped in `0.11.3`, so it never
opened for any real assistant and the schedule migration behind it was dead in
production for every user
([#40475](https://github.com/vellum-ai/vellum-assistant/pull/40475)). Set the
floor too low and you get a loud 404. Set it too high, which is the easier
mistake, and you get silence.

So new code calls the endpoint and lets the read degrade to the feature-off
state when the route is absent, which is [a data-fetching
convention](./CONVENTIONS.md#an-absent-endpoint-degrades-to-the-feature-off-state)
rather than a version check. That costs one unretried 404 against an
assistant that predates the route, and it cannot quietly withhold a feature
from people who do have it.

What is left in `src/lib/backwards-compat/` is a backlog: each module keeps a
dead legacy path alive alongside the current one.

## Where it lives

| Module                                                 | Role                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/backwards-compat/`                            | The registry itself. One file per gated feature, each declaring its own `MIN_VERSION` and documenting its old and new behavior in a module doc comment. `ls` the directory for the current backlog; this document does not restate it.              |
| `src/lib/backwards-compat/utils.ts`                    | The shared gate primitives: `useAssistantSupports`, `useAssistantScopedSupports`, `assistantSupports`, `assistantScopedSupports`, `whenAssistantVersionKnown`, `whenAssistantVersionKnownFor`. Every gate uses these, so version parsing is uniform. |
| `src/utils/semver.ts`                                  | Low-level `parseSemver` / `compareParsed` / `comparePreRelease`. No app knowledge, just version-string math.                                                                                                                                       |
| `src/stores/assistant-identity-store.ts`               | Zustand store holding the active assistant's `{ name, version }`. The source of truth every gate reads.                                                                                                                                           |
| `src/assistant/identity.ts`                            | Fetches identity from the assistant's `/identity` endpoint and refreshes it on the SSE `identity_changed` event.                                                                                                                                   |
| `src/lib/backwards-compat/impersonate-version-flag.ts` | Debug flag for overriding the reported version locally, so one machine can exercise both sides of a gate. See [Exercising a gate](#exercising-a-gate-before-you-delete-it).                                                                         |

## Reading a gate

`utils.ts` exposes these variants, all reading the active assistant version
off the identity store:

- **`useAssistantSupports(minVersion): boolean`**: the hook. Subscribes to
  the identity store via the `use.version()` selector, so a component (or a
  query whose `enabled`/key depends on it) **re-renders when the version
  flips**. Used on render paths.
- **`assistantSupports(minVersion): boolean`**: the snapshot. Reads
  `getState().version` once. Safe outside React, so event handlers, async
  ops, and request builders use it.
- **`useAssistantScopedSupports(minVersion, ownerAssistantId): boolean`**:
  the assistant-scoped hook. Like `useAssistantSupports`, but additionally
  requires the identity store's version to have been fetched for
  `ownerAssistantId` (the assistant owning the gated surface, such as a
  transcript or a live voice session), read as a single atomic snapshot.
  Conservative `false` on any mismatch or unknown. Used where the gated
  feature belongs to a specific assistant rather than whichever one is
  active.
- **`assistantScopedSupports(minVersion, ownerAssistantId): boolean`**: the
  non-hook form of the scoped check, for imperative callers. Narrows
  `ownerAssistantId` to `string` on `true`.
- **`whenAssistantVersionKnown(timeoutMs?): Promise<void>`**: resolves once
  the version is non-null, or after a 5 s timeout. Write paths await it
  before reading a snapshot gate. See [Read vs. write
  paths](#read-vs-write-paths).
- **`whenAssistantVersionKnownFor(ownerAssistantId, timeoutMs?): Promise<void>`**:
  the scoped wait. Resolves once the store holds a version fetched **for
  that assistant**, or after the timeout. A scoped write path needs this
  rather than the unscoped wait: across an assistant switch the store still
  carries the outgoing assistant's version, so the unscoped wait returns
  immediately and the following `assistantScopedSupports` read races the
  clear. Resolves immediately for a null owner.

### Version semantics

The comparison in `versionSupports()` has a few quirks that explain how an
existing gate behaves:

- **Unknown version returns `false`.** The version starts `null` and
  hydrates asynchronously after identity fetches. Until then every gate
  reports "not supported" and the app takes the legacy path.
- **Pre-release suffixes on the patch are ignored.** `0.8.5-rc.1` counts as
  `0.8.5`.
- **`dev` builds are treated as AHEAD of the stable release with the same
  base**, the opposite of strict semver. A build like
  `0.10.0-dev.202606211252.5cf8576` carries unreleased commits on top of
  `0.10.0`, so it counts as newer. Two dev builds with the same base compare
  by their pre-release string, which encodes a `dev.YYYYMMDDHHMM.sha`
  timestamp. This is why several `MIN_VERSION` constants are full dev
  strings rather than release numbers: they name the commit that landed the
  assistant-side change instead of predicting the release that would carry
  it.
- **Unparseable versions (either side) return `false`.**

### Read vs. write paths

The snapshot `assistantSupports()` collapses "version unknown" and "version
known but old" into the same `false`. That is safe for a read whose fallback
is a universally understood legacy route.

It is not safe for a write whose legacy fallback mutates state a newer
assistant would ignore, because the old-shaped write could go out to a new
assistant just because the version had not loaded yet. Those paths await
`whenAssistantVersionKnown()` first, then read the gate against a resolved
version instead of the conservative `false`. The avatar upload path is the
example: `assistant/avatar-api.ts` awaits
`resolveSupportsAvatarStateManifest()` before branching.

A write gate hides its affordance below `MIN_VERSION` rather than letting the
write fail, because a control that appears to work and silently drops what it
was given is worse than one that is not offered.

## Removing a gate

Removing a gate is the only change this directory should see. Take the new
behavior as unconditional and delete everything that existed to choose it:

1. Delete the legacy branch at every call site, keeping only the
   `MIN_VERSION`-and-above path. The module doc comment describes the old
   behavior you are dropping.
2. Delete the gate module and its colocated test.
3. Delete any comment elsewhere that explains the call site in terms of the
   gate.

Do not retarget a `MIN_VERSION` to a newer version instead. A floor that
names a release which never carries the feature stays shut forever, and
nothing surfaces it.

## Related compatibility seams (outside the registry)

A few compatibility concerns are not version gates and live with the code
they protect. They are not part of the backlog above:

- **SSE event parsing**: `src/lib/streaming/event-parser.ts` accepts both
  the enveloped event shape
  (`{ id, conversationId, seq, emittedAt, message }`) and the flat legacy
  shape (`{ type, … }`), wrapping the legacy form in a synthetic envelope so
  downstream callers only see one shape.
- **Message normalization**: `src/domains/chat/api/messages.ts`
  reconstructs the unified `contentBlocks` discriminated union from the
  older positional arrays (`textSegments`, `thinkingSegments`, `toolCalls`,
  `surfaces`, `attachments`, `contentOrder`) when a response omits
  `contentBlocks`, so the renderer only deals with one shape.
- **Electron / Capacitor bridge**: `src/runtime/is-electron.ts` declares
  `window.vellum` with **optional capability groups** (`helper?`,
  `featureFlags?`, `diagnostics?`, and so on). Consumers guard on presence
  (`window.vellum?.helper?.hotkey?.fnPushToTalk()`), so a renderer running
  against a shell that lacks a surface no-ops instead of crashing. This is
  capability detection, not version comparison, and it stays.
- **localStorage migrations**: `src/utils/storage-migration.ts` performs
  one-time, idempotent key renames (legacy keys into the `vellum:` /
  `device:` namespaces) at startup, before any store reads localStorage.
  This is client-internal versioning, not assistant compatibility.

Reads that tolerate an absent endpoint are also not a gate. That rule lives
with the rest of the data-fetching conventions, in [An absent endpoint
degrades to the feature-off
state](./CONVENTIONS.md#an-absent-endpoint-degrades-to-the-feature-off-state).

## Exercising a gate before you delete it

You do not need two assistant installs to check that the surviving path is
the one users get. The impersonation flag overrides the version every gate
sees:

```js
// In the browser console (debug builds expose window._vellumDebug.flags):
impersonateVersion("0.8.6"); // pretend the assistant is 0.8.6, then reload
impersonateVersion(null); // clear the override, then reload
impersonateVersion(); // log the current override, no reload
```

It persists to `localStorage`
(`vellum:debug:impersonateAssistantVersion`) and reloads the page, so the
whole app sees one consistent version. The identity store's `setIdentity`
substitutes the override, so no gate needs to know the flag exists.
