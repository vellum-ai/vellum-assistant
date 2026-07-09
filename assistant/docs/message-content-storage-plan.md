# Message Content Scalability

Status: Approved

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
- **Gate each phase on ~1 week of production observation** against defined metrics.
  Each phase is independently shippable and reversible.
- **One content resolver.** All content reads go through a single accessor at the
  row-fetch layer. Raw `content` is never parsed directly downstream.

## Phase 1 - Stream in-flight content to a file, off the SQLite lock

**Goal:** remove the high-frequency streaming writes from the shared write lock.

On ApolloBot, 25% of all event loop stalls are on `updateMessageContent`, which is
the method persisting every delta that comes back from the LLM (debounced). We can
offload this stream to a separate file during the LLM stream, then write back to
SQLite once we're done.

Write path:

1. On first token, create `$CONVERSATION_DIR/inflight/<messageId>.jsonl` and set the
   row's `content` to `{ "ref": "<workspace-relative path>" }`, `finalized = 0`.
2. Each partial flush (existing debounce cadence) **appends to the file**, not the
   DB. In-content timing stamps (`_startedAt` / `_previewStartedAt`) ride the file
   too, no separate per-flush `UPDATE` on the row (metadata/seq).
   - **Format:** append-only JSONL. Each line is
     `{ "i": <blockIndex>, "seq": <integer>, "block": <ContentBlock> }`. Folding
     keeps the highest-`seq` line per `i`, ordered by `i`.
   - **One writer per message.** The owning turn holds the fd open for the duration
     of the message and is the sole writer; queued/background turns for the same
     conversation operate on different message ids. Note: this is an
     application-level invariant, not OS-enforced — an open fd is not a lock on
     POSIX (any process can still open and write the file). It holds because a
     message id is owned by exactly one turn.
3. **Finalize** (once, at the turn/message seam): in a single transaction, write the
   folded `ContentBlock[]` inline into `content`, set `finalized = 1`; then delete
   the file. Enqueue the lexical + memory reindex here.

Reads:

- Batch/secondary readers (search, memory, fork, cross-conversation context) filter
  `WHERE finalized = 1` and never consume in-flight content.
- The only readers of `finalized = 0` content are **(a) the live turn** during
  `GET /messages` and **(b) crash recovery**.

## Phase 2 - Externalize only large finalized content (>32KB)

**Goal:** keep large finalized blobs out of the row (smaller rows → better cache
hit rate, smaller WAL on edits, smaller DB file / cheaper VACUUM).

SQLite maintainers observe that blobs at around the 50-100kb mark are more efficient
outside of SQLite, otherwise, inside of SQLite is actually more efficient. Given
that 90+% of messages will be below this threshold (user messages, tool calls, our
efforts to reduce text, etc), we are actually incentivized to keep as much in SQLite
as possible. Source:
[https://www.sqlite.org/intern-v-extern-blob.html](https://www.sqlite.org/intern-v-extern-blob.html)

- At finalize, measure the folded content size:
  - `≤ 32KB` → inline `ContentBlock[]` into `content`, delete file (Phase 1 behavior).
  - `> 32KB` → **keep the file** (move it out of `inflight/` to a stable
    `content/<messageId>.jsonl` under the conversation dir), set `content` to
    `{ ref }`, `finalized = 1`.
- Threshold is configurable (default 32KB).
- We will need to update all `finalized = 1` reads to now handle external content
  reference.

No schema change beyond Phase 1 — the union + `finalized` already exist.

## Phase 3 - Conversation sharding (opt-in)

**Goal:** distribute the _remaining_ write lock across DB files for just
conversation data.

Opt-in bc it's likely less of an issue for early/single threaded users, but more
needed for users who want high use of background sessions and multiple
conversations.

- prefer **fixed-K hash sharding**, not one-DB-per-conversation. This is because of
  the RAM each connection could load. It's this `K` that becomes configurable, and
  we assume a starting value of `K=1`.
- **Cross-conversation reads** (sidebar list, global search, cross-conv memory)
  still use the **central lightweight index DB** updated async at finalize.
- **Per-connection cache RAM:** `cache_size = -256000` is **~250MB per
  connection.** We would need to reduce this default to something similar to
  250MB/K. Doable if only managing conversation data.
- **Migration fan-out:** every future schema change must run across shards.
- **No cross-file FKs / transactions:** the `ON DELETE CASCADE` links
  (`tool_invocations`, `attachments`, etc.) would also be included in the sharded
  files. Any FK's that truly need to be cross-conversation can reference the
  central index.

## PR breakdown

No feature flags — each PR cuts over directly. Bake weeks start when a phase's
last PR merges.

| PR  | Scope                                                                                                                                                                                                                                | Status                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| 1   | Foundation: `finalized` column (migration 322), `content` union (`ContentBlock[] \| { ref }`), content resolver at the row-mapper chokepoint, in-flight JSONL format module (`message-content-file.ts`)                              | this PR                           |
| 2   | Streaming write path cutover: first token → in-flight file, flushes append, finalize folds inline; batch readers filter `finalized = 1`                                                                                              | pending                           |
| 3   | `GET /messages` resolves in-flight content for the live turn                                                                                                                                                                         | pending                           |
| 4   | Crash recovery sweep + orphan-file GC (extends existing startup reconcile machinery)                                                                                                                                                 | pending                           |
| —   | **Phase 1 bake (~1 week)**: `SQLITE_BUSY`/retry counts, event-loop stalls on `updateMessageContent`, at-rest `finalized = 0` count                                                                                                   |                                   |
| 5   | Phase 2: >32KB finalize branch keeps the file (`content/<messageId>.jsonl`), ref-resolution coverage for all `finalized = 1` readers (~20 direct `messages.content` query sites, incl. SQL-level scans that need inline-only guards) | pending                           |
| —   | **Phase 2 bake (~1 week)**: DB file size, WAL churn, VACUUM cost                                                                                                                                                                     |                                   |
| 6+  | Phase 3 (contingent): central index DB, K-shard router + pool, table moves, migration fan-out                                                                                                                                        | not planned unless metrics demand |
