# Referential Conversation Forking

> **Status:** Proposal / design. Nothing here is implemented yet. This document
> describes a way to fork conversations **by reference** instead of by copying
> every message row, while preserving the exact snapshot-isolation semantics
> the current copy-based fork guarantees.

## 1. Problem

Forking a conversation today physically duplicates the entire message history.
`forkConversation` (`assistant/src/memory/conversation-crud.ts:859`) slices the
source's messages through a boundary and inserts a brand-new row per message
into the fork:

```ts
for (const message of messagesToCopy) {
  const forkedMessageId = uuid();
  db.insert(messages).values({ id: forkedMessageId, conversationId: fc.id, ... }).run();
}
```

The async retrospective variant (`forkConversationForRetrospective`,
`conversation-crud.ts:1332`) does the same copy off the event loop via a
`sqlite3` subprocess (`fork-message-copy.ts`) precisely **because the copy is so
expensive it pegs the daemon's event loop for minutes on a multi-GB database**
(see the module header comment). That subprocess machinery is a symptom: the
copy is the cost we keep trying to hide.

Concretely, the costs of copy-based forking are:

- **Storage amplification.** A fork of a 3,000-message conversation writes 3,000
  duplicate rows. Fork a fork and you pay again. A handful of forks of a long
  thread multiplies the database.
- **Fork latency / event-loop stalls.** The copy is O(messages). It is the
  single longest uninterruptible block on the daemon (the reason
  `fork-message-copy.ts` exists at all).
- **Attachment re-scoping.** `populateForkContentsInProcess`
  (`conversation-crud.ts:1122`) re-links and re-scopes every attachment into the
  fork's directory — more duplicated work and disk.

The waste is fundamental: a fork's inherited prefix is **byte-identical** to the
parent's. We are copying immutable data.

## 2. Goal & non-goals

**Goal.** Make a fork store only a *pointer* to its parent and the message it
branched from, and reconstruct the inherited history at read time — with no
change to observable behavior. A fork must still:

- read back the same effective message list it does today (same order, same
  content, same compaction/working-window state);
- be **isolated** from later changes to the parent (snapshot semantics):
  editing, compacting, stripping, or deleting the parent must not corrupt a
  fork that already branched from it;
- survive parent deletion.

**Non-goals.**

- Changing the per-conversation *memory* state copies (activation, ever-injected,
  graph, attention, retrospective cursor, compaction ledger). These are O(1)–
  O(small), not O(messages); they are not the waste and stay copied at fork time.
- Live "shared/branching" editing where a change to the parent propagates into
  existing forks. That is the opposite of the isolation guarantee we must keep.
- Reworking subagent context injection (`subagent/manager.ts` already injects
  parent context in-memory rather than via a DB copy — it is unaffected).

## 3. Key invariant this rests on

**Message rows are immutable and append-only.** A conversation's *working window*
(what the model actually sees) is expressed by state **layered on top of** the
rows, never by mutating them:

- **Compaction** sets `contextSummary` / `contextCompactedMessageCount` /
  `contextCompactedAt` on the conversation row and appends a ledger event
  (`setConversationContextSummary`, `conversation-crud.ts:2138`). It does **not**
  delete message rows.
- **History strip** sets a single timestamp marker (`historyStrippedAt` via
  `setConversationHistoryStrippedAt`, `conversation-crud.ts:2167`). No row
  deletion.

So in normal operation a referenced prefix never changes. The only operations
that *physically* remove referenced rows are deletions, and there are exactly
three (Section 6):

1. `deleteConversation` — FK `messages.conversation_id REFERENCES conversations(id) ON DELETE CASCADE` (`schema/conversations.ts:92-94`) cascades.
2. `deleteMessageById` (`conversation-crud.ts:2862`) — single-row delete.
3. the `prune_old_conversations` job (`job-handlers/cleanup.ts:216`) — bulk delete of stale conversations.

The design makes referential reads correct for the immutable common case, and
handles those three deletion vectors with copy-on-write (Section 6).

## 4. Data model

The lineage columns already exist and are indexed:
`forkParentConversationId`, `forkParentMessageId`
(`schema/conversations.ts:38-39`, `idx_conversations_fork_parent_conversation_id`).

Add one discriminator column:

```
fork_materialized INTEGER NOT NULL DEFAULT 1
```

- A conversation is **referential** iff `fork_parent_conversation_id IS NOT NULL
  AND fork_materialized = 0`. Its `messages` rows contain **only** messages
  authored in the fork; the inherited prefix is resolved from ancestors.
- A conversation is **materialized** (`fork_materialized = 1`) when it owns a
  physical copy of its full history. This is true of every fork that exists
  today, so the migration backfills **all existing forks to `1`** and they keep
  working with zero behavior change.

Optional helper column (nice-to-have, not required): `fork_depth INTEGER` to make
the chain-depth cap a single read instead of a walk.

No new tables. No change to the `messages` schema.

## 5. Read path: lineage reconstruction

Define the **effective message list** of a conversation `C`. Walk the lineage
root→leaf and concatenate each ancestor's *own* rows, truncated at the boundary
the next conversation in the chain forked through:

```
resolveLineageSegments(C):
  chain = [C, parent(C), parent(parent(C)), ...] up to root,
          stopping at a materialized node (its rows are self-contained)
          and capped at MAX_FORK_CHAIN_DEPTH (=16, reuse existing constant)
  reverse → [A0 (root-or-materialized base), A1, ..., Ak = C]
  segments = []
  for i in 0..k:
    upperBoundMessageId = (i < k) ? A_{i+1}.forkParentMessageId : null   // boundary in A_i
    segments.push({ conversationId: A_i.id, throughMessageId: upperBoundMessageId })
  return segments

getEffectiveMessages(C):
  for each segment, select rows WHERE conversation_id = seg.conversationId
    AND (createdAt, id) <= boundary(seg.throughMessageId)   // all rows if null
    ordered by (createdAt, id)
  concatenate in segment order
```

Why this is correct and order-preserving:

- A fork's own messages are always created *after* its boundary message, so each
  ancestor's contributed slice is strictly older than the next conversation's
  slice. Concatenating root→leaf yields global chronological order — the same
  order `getMessages` produces today (it orders by `createdAt`, and forks copy
  `createdAt` verbatim).
- Within a segment we sort by `(createdAt, id)` — the exact tie-break the cursor
  readers already use (`getMessagesAfter`, `countMessagesAfter`) and that
  `forkConversation` re-sorts on for pinned cutoffs
  (`conversation-crud.ts:907`). The display-turn boundary extension
  (`findDisplayTurnEndIndex`) is applied to `throughMessageId` exactly as today,
  so tool_use ↔ tool_result pairing is preserved at every segment boundary
  (this is what the `conversation-fork-crud.test.ts` "advances fork boundary…"
  tests assert).

Inherited rows are returned with their **original ids** (from the ancestor),
not freshly-minted ones. This is the central behavioral change and it is
desirable: the `forkSourceMessageId` metadata stamp
(`cloneForkMessageMetadata`) becomes the identity map, so anything that maps
fork↔source collapses to a no-op. (The one existing test that asserts forked rows
get *new* ids — `conversation-fork-crud.test.ts:155-159` — encodes the copy
behavior and will be rewritten for referential forks.)

### Implementation surface

All physical-message readers funnel through the resolver. Two queries per read:
(1) the lineage walk (≤ depth cheap indexed lookups, or one recursive CTE), then
(2) one ranged `SELECT` over the union of segments. The readers and their
disposition:

| Function (`conversation-crud.ts`) | Change |
| --- | --- |
| `getMessages` (1727) | Fork-aware via resolver. |
| `getMessagesAfter` (1845) | Fork-aware; cursor resolves within the segment list. |
| `getMessagesPaginated` (1933) | Fork-aware; page newest→oldest *across* segments, segment descriptors carry the cross-conversation cursor. |
| `countMessagesAfter` (1796) | Fork-aware (sum across segments). |
| `selectSlackMetaCandidateMetadata` (1751) | Fork-aware (search spans segments). |
| `hasMessages` (1895) | **Stays local-only** — it answers "does this conversation own rows," used for existence checks, not history. |
| `collectImageManifest` (`compactor.ts:387`) | Fork-aware (inherited images come from ancestors). |
| `listMessages` HTTP route (`conversation-routes.ts:723`) | No change — inherits fork-awareness from `getMessagesPaginated`/`getMessages`. |

Because every materialized fork (all existing forks, plus any post-CoW fork)
short-circuits the walk at depth 0, the resolver is a no-op for them: the read
path is unchanged for the entire installed base and only does real work for
new referential forks.

## 6. Deletion: copy-on-write materialization

This is the crux. We preserve today's snapshot isolation by **deferring** the
copy to the rare moment a destructive op would otherwise corrupt a referenced
prefix — reusing the existing copy machinery as the materialization primitive.

Define `materialize(C)`: physically import `C`'s inherited prefix into `C`
(reusing `copyForkMessagesViaSubprocess` + `populateForkContentsInProcess`,
exactly as fork does today), then set `fork_materialized = 1` and clear/keep the
parent pointer. After this, `C` is self-contained. If `C` itself has referential
descendants, they now reference `C`'s physical rows and stay valid.

Finding live referential descendants of `X` is cheap: direct children via
`idx_conversations_fork_parent_conversation_id`, deeper via a bounded recursive
walk.

Handle each vector:

1. **`deleteConversation(X)`** (user delete). Inside the delete transaction: if
   `X` has referential descendants, `materialize` each direct referential child
   first (which absorbs `X`'s contribution into the child), then proceed with the
   cascade delete. The expensive copy now happens only when you delete a parent
   that *has* forks — far rarer than forking — and runs off the event loop via
   the same subprocess path. Net effect: **we moved the O(messages) copy from
   "every fork" to "delete a forked-from parent."**

2. **`deleteMessageById(m)`** (`conversation-crud.ts:2862`). If `m` falls inside a
   range a live referential fork inherits, `materialize` those forks first, then
   delete. (Mid-history single-message deletion is already semantically fraught —
   it can break tool pairing — and is rare; materialize-then-delete keeps forks
   correct.)

3. **`prune_old_conversations`** (`cleanup.ts:190`). Pruning is best-effort
   retention cleanup, so the simplest correct rule is **don't prune a
   conversation that is an ancestor of a live fork**. Add a `NOT EXISTS`
   guard to the stale-selection query:

   ```sql
   SELECT id FROM conversations c
   WHERE updated_at < ?
     AND NOT EXISTS (SELECT 1 FROM conversations f
                     WHERE f.fork_parent_conversation_id = c.id
                       AND f.fork_materialized = 0)
   ORDER BY updated_at ASC LIMIT ?
   ```

   When the last referential fork is deleted or materialized, the parent becomes
   prunable again. (Alternatively, prune could `materialize` descendants like
   `deleteConversation` — but deferring the prune is cheaper and equally
   correct.)

Because materialization reuses the **battle-tested copy path** (lock-friendly
batching, `cloneForkMessageMetadata` parity, attachment relink), we are not
throwing that code away — we are repurposing it from an always-run step into a
rarely-run safety valve.

## 7. What stays copied at fork time (unchanged)

These are small and keyed by `conversationId`; they are not the waste and remain
copied in `populateForkContentsInProcess`:

- `forkCompactionLedger` — a few rows; keeps the fork self-sufficient for its own
  future compactions. The fork still snapshots `contextSummary` /
  `contextCompactedMessageCount` / `contextCompactedAt` (and the Slack watermark)
  by the same at-or-before-boundary rule it uses today
  (`conversation-crud.ts:962-1019`). The compacted *count* is positional over the
  effective list, which the resolver reproduces identically — so compaction
  inheritance is unaffected.
- `forkActivationState`, `forkEverInjected`, `forkGraphMemoryState` — per-turn
  memory dedup/injection state.
- `seedForkedConversationAttention` — latest-assistant pointer (may now point at
  an ancestor's message id; that is a benign cross-conversation reference).
- `forkRetrospectiveState` — the message-id remap collapses to identity for
  inherited rows (same ids), simplifying it.

The **only** thing removed from the fork-time path is the O(messages) work: the
message-row insert loop (`conversation-crud.ts:1029-1049`) and the attachment
re-scope loop (`1136-1200`).

## 8. Attachments

Inherited messages keep their original ids, so their `message_attachments` links
already exist under the ancestor and resolve by `messageId`
(`getAttachmentMetadataForMessage`) regardless of which conversation reads them.
A referential fork therefore copies **no** attachments at fork time; it only owns
attachments on its own new messages. If an ancestor is later deleted, the
copy-on-write materialization (Section 6) re-scopes the affected attachments into
the descendant via the existing `linkAttachmentToMessage` / `relinkAttachments`
path — i.e. the attachment copy is deferred alongside the message copy.

## 9. Disk view

The on-disk JSONL projection (`conversation-disk-view.ts`) is an
export/inspection artifact — the agent reads history from the **database**, not
the JSONL (noted in `forkConversationForRetrospective`'s header). A referential
fork's directory holds only its own rows plus a small `lineage` descriptor; the
full-history rebuild (`rebuildConversationDiskViewFromDbState`,
`conversation-disk-view.ts:337`) and any export walk the lineage on demand. This
avoids re-duplicating history on disk and keeps the hot path (DB reads) the
source of truth.

## 10. Migration & rollout

1. **Schema migration** (additive): add `fork_materialized INTEGER NOT NULL
   DEFAULT 1`. Backfill is implicit — every existing fork is already a physical
   copy, so default `1` is correct. Zero data migration of message rows.
2. **Read layer**: land `resolveLineageSegments` + fork-aware readers behind the
   discriminator. For `fork_materialized = 1` (everything today) the resolver
   short-circuits — provably no behavior change for the installed base. Ship this
   first; it is inert until referential forks exist.
3. **Copy-on-write primitive**: `materialize(C)` + the three deletion guards.
4. **Write path**: `forkConversation` referential mode (skip the copy loops, set
   `fork_materialized = 0`) gated behind a feature flag
   (`meta/feature-flags`, e.g. `referential-conversation-forking`, default off).
5. **Disk view + attachments** lineage-awareness.
6. **Rollout**: enable the flag progressively; emit telemetry on fork latency,
   rows-saved, chain depth, and CoW-on-delete frequency. Keep
   `materialize(C)` exposed as an admin escape hatch to convert any referential
   fork back to a copy.

The read path tolerates both fork kinds simultaneously throughout, so rollout is
incremental and reversible — flipping the flag off simply makes new forks
copy-based again; existing referential forks keep resolving.

## 11. Performance

| | Copy (today) | Referential (proposed) |
| --- | --- | --- |
| Fork latency | O(messages) subprocess copy | O(1) row insert + small state copy |
| Storage / fork | N duplicated rows | ~0 rows |
| Read latency | O(N) | O(N) + ≤depth indexed lineage lookups |
| Big copy happens | on **every** fork | only on delete-of-a-forked-parent (rare) |

Read latency is unchanged in the dominant term: reconstructing N messages reads N
rows, the same as reading any N-message conversation. We pay the lineage walk
(bounded, indexed) on top. The expensive copy is not eliminated but **moved to a
much rarer event** and kept off the event loop.

**Secondary win:** a referential fork's reconstructed prefix is byte-identical to
the parent's, so provider **prompt-prefix caching** can hit across the parent and
its forks — a latency/cost reduction the eager copy already enables only
incidentally, and that referential forking preserves.

## 12. Risks & mitigations

- **A reader bypasses the resolver and sees only own rows.** Mitigation: funnel
  every history read through `getEffectiveMessages`; keep the local-only readers
  (`hasMessages`) explicitly enumerated and reviewed. The Section 5 table is the
  checklist.
- **Pagination across conversation boundaries.** The cross-segment cursor is the
  fiddliest piece; segment descriptors (conversationId + bound) make it
  tractable and testable against the existing `(createdAt, id)` semantics.
- **Chain depth.** Cap at `MAX_FORK_CHAIN_DEPTH` (16, already used for fork-chain
  walks at `conversation-crud.ts:796`); forking past the cap forces
  materialization at fork time, bounding read-time walk cost.
- **Delete/fork race.** The materialization decision and the delete must share a
  transaction (or per-conversation lock) so a fork created concurrently with a
  parent delete cannot slip past the descendant check.
- **Cross-conversation id references** (attention pointer, retrospective cursor
  now pointing at ancestor ids). Benign, but new; covered by CoW when the
  ancestor is removed.

## 13. Summary

Forking becomes a pointer plus a small state copy; history is reconstructed by
walking `forkParentConversationId` / `forkParentMessageId` at read time. The
copy we do today on every fork is deferred to a copy-on-write materialization
that fires only when a destructive op would otherwise break a referenced prefix.
Snapshot-isolation semantics are identical to today; the installed base of
copied forks keeps working untouched; the only thing we stop doing is duplicating
immutable message rows.
