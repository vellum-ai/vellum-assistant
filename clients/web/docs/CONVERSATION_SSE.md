# Conversation SSE & the chat transcript

How the web client turns the assistant's Server-Sent Event stream into the rendered
chat transcript. This is the one subsystem that intentionally keeps a
client-owned materialized view of server data, because the source of truth comes from
two APIs: the snapshot (GET /messages) and the stream (GET /events). Everywhere else, [server data has one owner: its query cache](./STATE_MANAGEMENT.md).

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
  assistant echoes back), so an optimistic send collapses onto its echoed server
  row with no duplicate. No timestamp sort — structural order only.

## The reducer is the single writer of transcript content

`transcript/rolling-snapshot.ts` is a pure, total, idempotent fold:

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
content.

Stream handlers (`utils/stream-handlers/*`) own only the **control plane** —
turn/interaction stores, reconciliation triggers, conversation-cache
`isProcessing` patches, queue bookkeeping, dismissed-surface persistence,
subagent re-anchoring — and never write transcript rows. To render content for a
new event, add a reducer case rather than mutating from a handler; that's what
keeps replay, resync, and rebuild equivalent.

## Optimistic sends

`use-send-message` adds the user's row to `optimisticSends` (`addOptimisticSend`)
the instant they hit send; the overlay renders it immediately. There is **no**
id-swap against the server id on POST resolve — the assistant echoes the
`clientMessageId` back on the persisted row and the overlay collapses the two on
that nonce. `user_message_echo` retires the optimistic copy of a text-only send;
a send that carries attachments is kept (upgraded to the server id, queue fields
cleared) because the echo has no attachment payload — the optimistic row holds
the only copy of the user's previews (blob URLs for pasted images) until the
turn-end reseed pulls the hydrated server row and
`pruneConfirmedOptimisticSends` retires it. While the snapshot is unseeded (the
first message of a freshly minted conversation) the echo retires nothing — the
paired fold has nowhere to land, so the reseed prune owns retirement there too.
Queued sends live here too, with `queueStatus`/`queuePosition` maintained by
the queue handlers via `setOptimisticSends`.

Nonce-less echoes (the field is optional; pre-idempotency assistants omit it)
have no shared key for the overlay to collapse on, so `handleUserMessageEcho`
falls back to retiring the most recent optimistic user send.

## Reconnect, resync, and reseed

The assistant's replay ring only holds ~30s of events, so a connection that reopens
later can't be ring-replayed. The recovery path is a refetch:

- Every committed `/messages` fetch **reseeds** the snapshot (`seedSnapshot`):
  it replays the buffered event tail with `seq > snapshot.seq` onto the fresh
  server snapshot (`resolveSnapshot`), so events that raced the fetch aren't
  lost. A buffer gap (eviction) falls back to the fetched snapshot alone.
  An **anchor-less** fetch (`seq: null` — the daemon has persisted no stream
  content yet, e.g. a fresh conversation's first turn racing the 1s
  partial-persist debounce) is **dropped** when the live view has already
  folded seq-stamped events: with no cursor to replay from, taking it
  wholesale would wipe the streamed turn (the mid-turn "vanishing prefix"
  flicker) until the turn-end reseed restored it. A **stale-anchored** fetch
  (`seq` strictly below the live view's) whose gap the ring can't bridge is
  dropped for the same reason: it was in flight before newer events folded
  in, and taking it wholesale would regress the view — e.g. erase a just-sent
  user row whose echo already retired the optimistic copy (the send flicker).
- The reseed also **prunes** any optimistic send the snapshot now represents
  (`pruneConfirmedOptimisticSends`), keyed by the same identity
  `selectTranscriptMessages` overlays on. Without this, a send whose echo/dequeue
  was missed on a flaky connection would stay rendered as optimistic/queued
  forever even though the server snapshot already contains it.
- When a turn returns to idle, history is invalidated; the committed-snapshot
  effect then reseeds from the authoritative server copy (canonical ids/ordering,
  persisted surfaces), replacing the client-folded turn.

## Invariant

The fold is certified by a property test (`rolling-snapshot.test.ts`): rebuilding
the history from a snapshot plus a run of events equals applying those events
incrementally — and a noisy stream (duplicates, out-of-order, replayed tail)
produces the same history as a clean one. Keep new reducer cases pure and
`seq`-idempotent so that invariant holds.

## Map

| Concern | Lives in |
| --- | --- |
| Render seam | `transcript/use-transcript-messages.ts` → `selectTranscriptMessages` |
| Content fold (single writer) | `transcript/rolling-snapshot.ts` |
| Snapshot + optimistic sends store | `chat-session-store.ts` |
| Event-stream wiring (feeds reducer + handlers) | `hooks/use-event-stream.ts` |
| Control-plane handlers | `utils/stream-handlers/*` |
| Send / optimistic / queue | `hooks/use-send-message.ts`, `hooks/use-message-queue.ts` |
| Reseed + reconnect refetch | `hooks/use-conversation-history.ts`, `hooks/use-message-reconciliation.ts` |
| Event buffer (resync tail) | `lib/streaming/stream-debug.ts` |
