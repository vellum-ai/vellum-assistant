# Message Content Storage — Phased Contention & Size Plan

**Status:** Draft / RFC
**Owner:** _(you)_
**Scope:** `assistant/src/persistence` (messages table + content read/write paths), `assistant/src/daemon` (agent-loop write path, startup recovery)

## Problem

`messages.content` is a `TEXT` column holding the full `ContentBlock[]` JSON for every
message. During a streaming turn it is rewritten in place many times via
`updateMessageContent` — debounced partial flushes plus high-frequency
in-content timing stamps (`_startedAt` / `_previewStartedAt`). Every rewrite is a
full-row rewrite that dirties the message's overflow-page chain into the WAL, and
every writer funnels through SQLite's single write lock. The result is:

1. **Write contention** on the shared lock, dominated by frequent full-blob
   rewrites of the in-flight message.
2. **DB file / WAL growth** from large inline blobs (p90 is under ~100KB, but the
   tail reaches ~128k output tokens ≈ 500KB+).

Full-value rewrite on `UPDATE` is inherent to SQLite (and to any in-place file
rewrite). The controllable costs are **write frequency**, **blob size**, and
**funneling through one lock/WAL**. This plan attacks them in that order.

## Principles

- **SQLite stays the source of truth.** The row remains the authoritative index +
  metadata. Files hold content payloads only; they are never independently
  authoritative and are always reconstructable-from or collapsible-into the row.
- **Reduce work before distributing work.** Externalizing the hot blob (Phases 1–2)
  is "reduce"; sharding (Phase 3) is "distribute". Only distribute if reducing
  wasn't enough.
- **Gate each phase on ~1 week of production observation** against defined metrics
  (below). Each phase is independently shippable and reversible.
- **One content resolver.** All content reads go through a single accessor at the
  row-fetch layer. Raw `content` is never parsed directly downstream.

## Data model

One migration (`assistant/src/persistence/migrations/NNN-message-content-externalization.ts`,
next sequence number) + a `schema/conversations.ts` update:

| Change | Detail |
| --- | --- |
| `content` semantics | Column stays `TEXT`. Value is now a **union**: `ContentBlock[]` (inline, existing behavior) **or** `{ "ref": "<relative-path>" }` (content lives in a file). Disambiguated on read by shape (`Array.isArray(parsed)`). |
| `finalized` column | New `INTEGER` (0/1), **default `1`** so every existing row backfills as finalized-inline. Set to `0` while a message streams to a file; flipped to `1` at finalize. |
| interrupted marker | No new column. A message finalized-as-interrupted by crash recovery records this in the existing `metadata` JSON (e.g. `metadata.interrupted = true`). |

**Invariant:** exactly one of `{ inline ContentBlock[], { ref } }` describes a row's
content at any time. `finalized` × file-presence encodes the lifecycle — no third
state column:

- `finalized = 0`, file present → **streaming**.
- `finalized = 0`, no file yet → **reserved / pre-first-token** (resolver returns `[]`).
- `finalized = 1`, inline array → **finalized, small** (the common case).
- `finalized = 1`, `{ ref }` → **finalized, externalized** (Phase 2).

## The content resolver (built in Phase 1, used by all phases)

Add a single choke point at the row-fetch layer (`getMessageById` / `getMessages`
in `conversation-crud.ts`) that returns **resolved** content:

```
resolveContent(row):
  parsed = JSON.parse(row.content)
  if parsed is Array        -> return parsed                     // inline
  if parsed is { ref }      -> return readAndFold(ref)           // file-backed
  else                      -> return []                          // placeholder
```

- Every downstream consumer — `extractTextFromStoredMessageContent`,
  `extractMediaBlocks`, `stringifyMessageContent`, `syncMessageToDisk`, the lexical
  (`messages_lexical`) and memory indexers — receives an already-resolved
  `ContentBlock[]`. They must **never** see a raw `{ ref }` value.
- Because `{ ref }` externalized content is resolved here, large finalized
  messages are still fully indexable/searchable (the indexer reads through the
  resolver, which reads the file).

## In-flight file format & location

- **Location:** inside the conversation's existing disk-view directory —
  `<workspace>/conversations/<ISO>_<conversationId>/inflight/<messageId>.jsonl`.
  Colocating means conversation deletion already GCs it (the disk-view code owns
  dir cleanup), and it lives on the **durable workspace volume** (survives daemon
  restart — required for crash recovery). Do **not** use `/tmp` (ephemeral) or a
  path named `tmp` (invites a future "clean tmp on startup" job that would wipe
  recovery state).
- **Format:** append-only JSONL. Each line is `{ "i": <blockIndex>, "block": <ContentBlock> }`.
  A flush appends only the block(s) that changed, so writes are small and
  genuinely append-only. **Fold on read:** group lines by `i`, take the last entry
  per `i`, order by `i` → `ContentBlock[]`. (This is append-only for the *file*;
  the SQLite representation is unchanged — no move to an append-only DB model.)
- **One writer per message.** The owning turn holds the fd open for the duration
  of the message and is the sole writer; queued/background turns for the same
  conversation operate on different message ids.

## Phase 1 — Stream in-flight content to a file, off the SQLite lock

**Goal:** remove the high-frequency streaming writes from the shared write lock.

Write path:

1. On first token, create `inflight/<messageId>.jsonl` and set the row's `content`
   to `{ "ref": "inflight/<messageId>.jsonl" }`, `finalized = 0`.
2. Each partial flush (existing debounce cadence) **appends to the file**, not the
   DB. In-content timing stamps (`_startedAt` / `_previewStartedAt`) ride the file
   too — confirm no separate per-flush `UPDATE` on the row survives (metadata/seq).
3. **Finalize** (once, at the turn/message seam): in a single transaction, write the
   folded `ContentBlock[]` inline into `content`, set `finalized = 1`; then delete
   the file. Enqueue the lexical + memory reindex here (finalize is the
   genuine content-change seam — nothing is indexed mid-stream).

Reads:

- Batch/secondary readers (search, memory, fork, cross-conversation context) filter
  `WHERE finalized = 1` — they never consume in-flight content.
- The only readers of `finalized = 0` content are assumed to be **(a) the live turn**
  (which mostly holds a memory working buffer anyway) and **(b) crash recovery**.
  _Assumption to verify against `getMessages` callers before implementation_ — if a
  concurrent request / SSE-resume / queued-message path also reads in-flight
  content, it must go through the resolver.

Crash recovery (extend the existing startup sweeps near `startOrphanReaper` /
`reconcile*OnStartup` in `daemon/lifecycle.ts`):

- For each `finalized = 0` row at startup: if its file exists, fold it and finalize
  (optionally stamp `metadata.interrupted = true`); if no file, the message never
  produced content → mark interrupted / discard per client policy.
- Orphan-file GC: delete `inflight/*.jsonl` files with no matching `finalized = 0`
  row.
- Define the **client-facing outcome** for an interrupted message (errored bubble
  vs. silent drop) — recovery policy, not stored state.

**Ship criterion → observe ~1 week** (see Metrics). Proceed to Phase 2 only if
contention improved but blob size / WAL churn on finalize+edits is still a concern.

## Phase 2 — Externalize only large finalized content (>32KB)

**Goal:** keep large finalized blobs out of the row (smaller rows → better cache
hit rate, smaller WAL on edits, smaller DB file / cheaper VACUUM).

This **reuses Phase 1's file mechanism and resolver** — it is a branch at finalize,
not a new subsystem:

- At finalize, measure the folded content size:
  - `≤ 32KB` → inline `ContentBlock[]` into `content`, delete file (Phase 1 behavior).
  - `> 32KB` → **keep the file** (move it out of `inflight/` to a stable
    `content/<messageId>.jsonl` under the conversation dir), set `content` to
    `{ ref }`, `finalized = 1`.
- Threshold is configurable (default 32KB — comfortably below the ~100KB
  internal-vs-external read crossover, chosen to bound row/overflow size).
- Post-finalize edits (channel edits, consolidation) that cross the threshold in
  **either** direction promote/demote **once** at the edit seam. GC the old file on
  any ref change or on message delete (reuse cascade/orphan machinery).

No schema change beyond Phase 1 — the union + `finalized` already exist.

**Ship criterion → observe ~1 week.** Proceed to Phase 3 only if residual write
contention is still over budget.

## Phase 3 — Conversation sharding (opt-in, contingent)

**Goal:** distribute the *remaining* write lock across DB files. Expected to be
**unnecessary** after Phases 1–2 (residual `messages` writes are just insert +
one finalize txn), so this is opt-in and config-gated, evaluated only if metrics
demand it.

Design constraints if pursued (prefer **fixed-K hash sharding**, not one-DB-per-conversation):

- **Cross-conversation reads** (sidebar list, global search, cross-conv memory) need
  a **central lightweight index DB** updated async at finalize — per-DB fan-out is a
  non-starter for interactive reads.
- **Per-connection cache RAM:** `cache_size = -256000` is **~250MB per connection**.
  A fixed-K scheme with a small per-shard cache + bounded open handles keeps RAM
  predictable; per-conversation DBs require an LRU handle pool or RAM blows up.
- **Migration fan-out:** every future schema change must run across shards
  (lazily on open or a batch sweep); the startup readiness/gating model assumes a
  known set of DBs.
- **No cross-file FKs / transactions:** the `ON DELETE CASCADE` links
  (`tool_invocations`, `attachments`, etc.) and fork's cross-conversation copy must
  be handled in app code if content-bearing tables move.

## Migrations

- Update `schema/conversations.ts`: document the `content` union, add `finalized`
  (`integer`, default `1`).
- Add `assistant/src/persistence/migrations/NNN-message-content-externalization.ts`:
  `ALTER TABLE messages ADD COLUMN finalized INTEGER NOT NULL DEFAULT 1`. Existing
  rows are finalized-inline; no content rewrite needed. Self-contained per the
  migrations AGENTS.md conventions.

## Observation gates (per phase)

Define the gate; don't eyeball it. Baseline before Phase 1, compare after each.

| Metric | Signal | Phase(s) |
| --- | --- | --- |
| `SQLITE_BUSY` / lock-timeout counts | primary contention signal | 1, 3 |
| `withSqliteRetry` retry histogram | contention severity | 1, 3 |
| Turn-finalize + write latency p90/p99 | user-visible impact | 1, 2 |
| WAL size + checkpoint frequency | write/churn volume | 1, 2 |
| DB file size / VACUUM cost | Phase 2 success metric | 2 |
| Count of `finalized = 0` rows **at rest** | recovery health — should be ~0 outside active turns; a growing floor = leaked/crashed in-flight = recovery bug | 1 |
| Orphaned `inflight/` file count | recovery health | 1 |

**Cheap parallel lever to A/B in week 1** (borrowed from Hermes' multi-tenant
SQLite design): shorter `busy_timeout` + `BEGIN IMMEDIATE` + jittered application
retry + frequent `PASSIVE` WAL checkpoints. If this alone moves `SQLITE_BUSY`
materially, it buys headroom while Phase 1 lands and tells you how much of the
contention was lock-wait vs. WAL churn — which sharpens whether Phase 3 is ever
needed.

## Open questions / assumptions

1. **Who reads `finalized = 0` content?** Assumed: live turn + crash recovery only.
   Verify against `getMessages` / `getMessageById` callers before building — it
   sizes the read-cutover surface.
2. **Interrupted-message client policy:** errored bubble vs. silent drop on
   crash-recovered partials.
3. **Fold cost:** folding a large in-flight JSONL on read is O(lines). Fine for the
   live turn (small, recent); confirm recovery replay of a pathological file is
   bounded.

## Risks

- **Resolver leak:** any content read that bypasses the resolver and parses raw
  `content` will break on `{ ref }` rows. Mitigate by routing all reads through
  `getMessages`/`getMessageById` and auditing direct `messages.content` access.
- **Recovery correctness:** the `finalized = 0` startup sweep is load-bearing for
  durability; a bug leaks in-flight files / loses partials. Covered by the at-rest
  `finalized = 0` count metric.
- **File/row divergence window:** between a file append and finalize, the file is
  ahead of the row. Acceptable — in-flight content is recoverable/discardable, and
  finalize is atomic (txn writes column + `finalized = 1`, then deletes file; a
  crash in that gap leaves a harmless orphan or a replayable `finalized = 0` row).
```
