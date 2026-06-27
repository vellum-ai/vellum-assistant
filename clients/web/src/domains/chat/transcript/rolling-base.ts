/**
 * Rolling-base reducer — Phase 1 of the client-sync materialized-view design
 * (see the Client Sync "Rolling-Base Materialized View" proposal).
 *
 * The **base** is the client's continuously-advanced view of a conversation:
 * the `/messages` snapshot shape, projected to `DisplayMessage[]`, carrying its
 * own provenance in `seq` — the highest global event `seq` folded in (the
 * doc's `version`). It is *not* the frozen page-load payload; it is a running
 * balance seeded once by the snapshot and advanced by `applyEvent`.
 *
 * `RollingBase` is deliberately `PaginatedHistoryResult` verbatim — the
 * `/messages` response shape with `messages: DisplayMessage[]` instead of the
 * raw `ConversationMessage[]` — so the base and the snapshot are the same type
 * until the runtime/display models are fully unified.
 *
 * This module is the reducer ONLY (doc §4): one pure, total, idempotent
 * function the live path and the rebuild path will both run, so they can never
 * diverge. It is unwired in this phase — ingestion (the seam window: ordering,
 * gap detection) and render derivation come in later phases. What it
 * guarantees now is certified by `rolling-base.test.ts` against the doc's
 * invariant (§10): a noisy event stream (duplicates + already-folded replays)
 * produces the same base as the clean stream.
 *
 *   - **Pure** — no side effects, no `Date.now()` / `crypto.randomUUID()` in
 *     the fold: a row this event opens is stamped from the event itself, so
 *     re-derivation is byte-identical.
 *   - **Total** — events it does not fold (tool/surface/queue/lifecycle, and
 *     unknowns) return the base unchanged rather than throwing. Folding for
 *     those is the next increment.
 *   - **Idempotent** — keyed by `event.seq`: an event at or below the base's
 *     `seq` has already been folded and is dropped. This is what makes replay
 *     after reconnect and overlap with a resync safe.
 */

import type { AssistantEvent } from "@/types/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import {
  appendTextDelta,
  appendThinkingDelta,
  applyUserMessageEcho,
  finalizeMessageComplete,
  finalizeOnIdle,
  handleConversationError,
} from "@/domains/chat/utils/stream-updaters/message-updaters";
import { messageIdentityKeys } from "@/domains/chat/utils/message-identity";

/**
 * The client-side materialized base. Identical to a `/messages` page result;
 * `seq` is the version — the highest global event seq folded in, or `null`
 * before any seq-bearing input has landed.
 */
export type RollingBase = PaginatedHistoryResult;

/**
 * An event as the reducer consumes it: the wire `message`, its global `seq`
 * (the SSE envelope's), and a `timestampMs` used as the deterministic creation
 * stamp for any row the event opens. All three come straight off the
 * `AssistantEventEnvelope` at ingestion time.
 */
export interface SeqEnvelope {
  seq?: number | null;
  timestampMs?: number;
  message: AssistantEvent;
}

/** Fold one event's effect into the message list. Pure; no row creation here
 *  reads a clock — the reducer re-stamps opened rows deterministically. */
function foldMessages(
  messages: DisplayMessage[],
  message: AssistantEvent,
): DisplayMessage[] {
  switch (message.type) {
    case "assistant_text_delta":
      return appendTextDelta(messages, message.text, message.messageId);
    case "assistant_thinking_delta":
      return appendThinkingDelta(messages, message.thinking, message.messageId);
    case "message_complete":
      return finalizeMessageComplete(messages, message);
    case "user_message_echo":
      return applyUserMessageEcho(messages, {
        text: message.text,
        messageId: message.messageId,
        clientMessageId: message.clientMessageId,
      });
    case "assistant_activity_state":
      // Only the terminal `idle` phase changes message content (it finalizes
      // running tool calls). Other phases drive turn state, not the base.
      return message.phase === "idle" ? finalizeOnIdle(messages) : messages;
    case "conversation_error":
      return handleConversationError(messages);
    default:
      // Total: every event the reducer does not yet fold leaves the base
      // untouched. Tool/surface/queue folding is the next increment.
      return messages;
  }
}

/**
 * Re-stamp the `timestamp` of any row this event opened with a value derived
 * from the event, so a created row is identical whether folded live or on
 * rebuild. Rows that already existed in `before` (appends, finalizes) keep
 * their timestamps. Allocates only the newly-created rows.
 */
function stampOpenedRows(
  before: DisplayMessage[],
  after: DisplayMessage[],
  createdAt: number,
): DisplayMessage[] {
  if (after === before) return after;
  const knownIds = new Set<string>();
  for (const row of before) {
    for (const key of messageIdentityKeys(row)) knownIds.add(key);
  }
  let changed = false;
  const stamped = after.map((row) => {
    const isNew = !messageIdentityKeys(row).some((key) => knownIds.has(key));
    if (!isNew) return row;
    changed = true;
    return { ...row, timestamp: createdAt };
  });
  return changed ? stamped : after;
}

/**
 * Fold one event into the base. Pure, total, idempotent.
 *
 * Idempotency: an event whose `seq` is at or below the base's `seq` has
 * already been folded — return the base unchanged. Events without a `seq` (or
 * onto a base without one) can't be deduped, so they always apply; the seam
 * window upstream is what keeps the stream contiguous and seq-bearing.
 */
export function applyEvent(base: RollingBase, env: SeqEnvelope): RollingBase {
  const { seq, message } = env;
  if (
    typeof seq === "number" &&
    typeof base.seq === "number" &&
    seq <= base.seq
  ) {
    return base;
  }

  const folded = foldMessages(base.messages, message);
  const createdAt = env.timestampMs ?? (typeof seq === "number" ? seq : 0);
  const messages = stampOpenedRows(base.messages, folded, createdAt);

  const nextSeq =
    typeof seq === "number" ? Math.max(base.seq ?? -1, seq) : base.seq ?? null;

  if (messages === base.messages && nextSeq === base.seq) return base;
  return { ...base, messages, seq: nextSeq };
}

/**
 * Rebuild the base from a seed snapshot and a sequence of events — the
 * full-recomputation path the invariant (doc §10) certifies against the
 * incremental path. Pure: `events.reduce(applyEvent, seed)`.
 */
export function rebuildBase(
  seed: RollingBase,
  events: readonly SeqEnvelope[],
): RollingBase {
  return events.reduce(applyEvent, seed);
}
