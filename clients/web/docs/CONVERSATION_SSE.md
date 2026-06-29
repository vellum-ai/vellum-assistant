# Conversation SSE & the chat transcript

How the web client turns the daemon's Server-Sent Event stream into the rendered
chat transcript. This is the one subsystem that intentionally keeps a
client-owned materialized view of server data; everywhere else, [server data has
one owner: its query cache](./STATE_MANAGEMENT.md).

## The shape

The rendered transcript is one derived value:

```
transcript = selectTranscriptMessages(snapshot ⊕ optimisticSends)
```

- **`snapshot`** (chat-session store, `PaginatedHistoryResult | null`) — the
  conversation's history in the `/messages` page shape, projected to
  `DisplayMessage[]`. Seeded from the server snapshot and advanced by folding
  stream events. This is the single source of *committed* transcript content:
  assistant text/reasoning, tool calls and results, surfaces, the inline
  confirmation marker, echoed user rows.
- **`optimisticSends`** (chat-session store, `DisplayMessage[]`) — user messages
  the client has sent but the server hasn't echoed back yet (including queued
  sends). Held apart from the snapshot so it's explicit they're unconfirmed.
- **`useTranscriptMessages`** — the single read seam. `selectTranscriptMessages`
  overlays the optimistic rows onto the snapshot by message identity (server id,
  a `mergedMessageIds` alias, or the client-minted `clientMessageId` nonce the
  daemon echoes back), so an optimistic send collapses onto its echoed server row
  with no duplicate. No timestamp sort — structural order only.

## The reducer is the single writer of transcript content

`transcript/rolling-base.ts` is a pure, total, idempotent fold:

- **pure / deterministic** — no `Date.now()` / `crypto.randomUUID()` in the
  fold; every row it opens is stamped from the event's `emittedAt` (`at`), so a
  row is identical whether built live or rebuilt from a snapshot.
- **total** — events that don't change transcript content (turn lifecycle,
  queue, subagent/workflow, sync, unknowns) return the list unchanged.
- **idempotent by `seq`** — an event whose `seq` is at or below the snapshot's
  `seq` is already folded and is dropped. `seq` is a global per-assistant
  monotonic watermark, sparse per conversation — used only for idempotency, never
  as a per-conversation array index.

`use-event-stream` feeds **every** active-conversation envelope to the reducer
(`applyEnvelopeToSnapshot`). That fold is the only thing that writes transcript
content. Concretely, the reducer owns: `assistant_text_delta`,
`assistant_thinking_delta`, `message_complete`, `user_message_echo`,
`assistant_activity_state(idle)`, `conversation_error`, `tool_use_preview_start`,
`tool_use_start`, `tool_result`, `tool_output_chunk`, `ui_surface_*`,
`confirmation_request`, and `interaction_resolved`.

### Why the stream handlers no longer touch messages

`utils/stream-handlers/*` keep only the **control plane** — turn-store
transitions, the interaction store (pending secret/confirmation/question),
reconciliation triggers, conversation-cache `isProcessing` patches, queue
bookkeeping, dismissed-surface persistence, subagent re-anchoring. They do **not**
mutate transcript rows. So:

- A handler that looks like it "does nothing" for a content event (e.g.
  `tool_output_chunk`, `ui_surface_update`) is correct — the reducer folded the
  content; the handler had no control-plane work to do.
- `confirmation_request` / `interaction_resolved` fold the inline confirmation
  marker via the reducer like everything else. `handleConfirmationRequest` still
  computes the matched tool-call id, but **read-only**, only to wire the
  interaction store — it does not write the row.
- The current streaming assistant message id is stamped from the event's
  `messageId` (the row the daemon reserved at turn start), read by
  `subagent_spawned` for parent attribution and by `message_complete` to
  re-anchor onto the durable server id.

If you find yourself writing transcript content from a handler, add a reducer
case instead — keeping the fold the single write path is what makes replay,
resync, and rebuild equivalent.

## Optimistic sends

`use-send-message` adds the user's row to `optimisticSends` (`addOptimisticSend`)
the instant they hit send; the overlay renders it immediately. There is **no**
id-swap against the server id — the daemon echoes the `clientMessageId` back on
the persisted row, the overlay collapses the two on that nonce, and
`user_message_echo` clears the optimistic copy (`clearOptimisticSend`). Queued
sends live here too, with `queueStatus`/`queuePosition` maintained by the queue
handlers via `setOptimisticSends`.

Nonce-less echoes (the field is optional; pre-idempotency daemons omit it) have
no shared key for the overlay to collapse on, so `handleUserMessageEcho` falls
back to retiring the most recent optimistic user send.

## Reconnect, resync, and reseed

The daemon's replay ring only holds ~30s of events, so a connection that reopens
later can't be ring-replayed. The recovery path is a refetch:

- Every committed `/messages` fetch **reseeds** the snapshot (`seedSnapshot`):
  it replays the buffered event tail with `seq > snapshot.seq` onto the fresh
  server snapshot (`resolveSnapshot`), so events that raced the fetch aren't
  lost. A buffer gap (eviction, or no anchor) falls back to the fetched snapshot
  alone.
- The reseed also **prunes** any optimistic send the snapshot now represents
  (`pruneConfirmedOptimisticSends`), keyed by the same identity
  `selectTranscriptMessages` overlays on. Without this, a send whose echo/dequeue
  was missed on a flaky connection would stay rendered as optimistic/queued
  forever even though the server snapshot already contains it.
- When a turn returns to idle, history is invalidated; the committed-snapshot
  effect then reseeds from the authoritative server copy (canonical ids/ordering,
  persisted surfaces), replacing the client-folded turn.

## Invariant

The fold is certified by a property test (`rolling-base.test.ts`): rebuilding the
history from a snapshot plus a run of events equals applying those events
incrementally — and a noisy stream (duplicates, out-of-order, replayed tail)
produces the same history as a clean one. Keep new reducer cases pure and
`seq`-idempotent so that invariant holds.

## Map

| Concern | Lives in |
| --- | --- |
| Render seam | `transcript/use-transcript-messages.ts` → `selectTranscriptMessages` |
| Content fold (single writer) | `transcript/rolling-base.ts` |
| Snapshot + optimistic sends store | `chat-session-store.ts` |
| Event-stream wiring (feeds reducer + handlers) | `hooks/use-event-stream.ts` |
| Control-plane handlers | `utils/stream-handlers/*` |
| Send / optimistic / queue | `hooks/use-send-message.ts`, `hooks/use-message-queue.ts` |
| Reseed + reconnect refetch | `hooks/use-conversation-history.ts`, `hooks/use-message-reconciliation.ts` |
| Event buffer (resync tail) | `lib/streaming/stream-debug.ts` |
