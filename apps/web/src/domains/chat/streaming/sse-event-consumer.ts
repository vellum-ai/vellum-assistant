/**
 * Conversation-scoped consumer of `sse.event` envelopes.
 *
 * The bus delivers every event from a single unfiltered SSE
 * connection. This module runs connection-wide seq-gap detection (and
 * triggers a reconcile when a gap is observed), applies the
 * cross-conversation filter that keeps other conversations' events
 * from leaking into the active view, and dispatches the surviving
 * events to the caller's handler.
 *
 * Cross-conversation filter:
 *   1. Global events (`sync_changed`, `home_feed_updated`, etc.) are
 *      not tied to a conversation — always dispatched.
 *   2. Conversation-scoped events are dispatched only when their
 *      `conversationId` matches the current active conversation.
 *      Events whose conversationId is missing or mismatched are not
 *      dispatched: a missing id is treated as "unknown conversation"
 *      rather than "broadcast," because under the bus-owned unfiltered
 *      SSE there is no per-conversation subscription URL to fall back
 *      to for routing.
 *
 * The active-conversation key is read from a ref the caller updates
 * in the commit phase — see `use-event-stream.ts`. The ref pattern
 * lets an `assistant_text_delta` published in the gap between a
 * conversation switch and the effect cleanup get rejected as soon as
 * React commits the new active key. A direct closure capture would
 * leak deltas into the new conversation until the cleanup ran.
 *
 * Seq-gap detection:
 *   `seq` is a single global per-assistant counter the daemon stamps
 *   on every conversation-scoped event, so gap detection runs against
 *   one connection-wide cursor BEFORE the active-conversation filter —
 *   observing only the active conversation's events would see a jump on
 *   every cross-conversation interleave and false-positive. The cursor
 *   is the same one the transport sends on reconnect (see
 *   `reconnect-cursor.ts`).
 *   - The first event on a cold connection seeds the cursor without
 *     reconciling.
 *   - An event whose seq < cursor: the daemon's counter restarted
 *     (daemon restart). Replace the stale cursor and reconcile.
 *   - An event whose seq > cursor + 1: events were missed on the
 *     connection. Fire a reconcile of the active conversation and defer
 *     cursor advancement until it resolves. While a reconcile is
 *     in-flight, subsequent gap events are debounced — only the latest
 *     seq is tracked. On success the cursor jumps to the latest seq; on
 *     failure it stays pinned so the next event retries.
 *   - On the normal (no-gap) path the cursor advances AFTER the
 *     handler returns. A thrown handler keeps the cursor pinned so the
 *     next event re-triggers the gap path.
 *
 * Per-conversation idempotent apply:
 *   Past the active-conversation filter, each applied event advances a
 *   per-conversation frontier (`local-seq.ts`). An event whose seq is
 *   at or below that frontier has already been applied to the transcript
 *   (a replay after reconnect, or overlap with an in-flight reconcile),
 *   so it is skipped rather than re-applied — re-running a delta handler
 *   would double-append. This is the stream-side half of the monotonic
 *   merge: the frontier is what tells the snapshot/stream reconcile how
 *   far the stream has carried the conversation.
 *
 * Reconnect handling:
 *   On reconnect the transport sends the cursor as `lastSeenSeq` and
 *   the daemon replays every buffered event with `seq > cursor` from
 *   its global ring before going live, so a normal reconnect resumes
 *   without any gap. If the cursor is older than the ring window, the
 *   daemon goes live from a higher seq and gap detection refetches.
 */

import { useStreamStore } from "@/domains/chat/stream-store";
import { isConversationScopedStreamEvent } from "@/domains/chat/utils/chat";
import { recordDiagnostic } from "@/lib/diagnostics";
import { getLocalSeq, recordLocalSeq } from "@/lib/streaming/local-seq";
import {
  advanceReconnectCursor,
  getReconnectCursor,
  replaceReconnectCursor,
} from "@/lib/streaming/reconnect-cursor";
import type { AssistantEvent } from "@/types/event-types";

/**
 * Narrow input shape — only the three envelope fields the consumer
 * actually reads. The bus delivers `AssistantEventEnvelope` (from
 * `@vellumai/assistant-api`), which is covariant with this shape, so
 * the hook can pass the full envelope through unchanged. Keeping the
 * input type narrow here means test fixtures can build partial
 * envelopes without lying about full-shape with a double-cast.
 */
export interface ConsumableEnvelope {
  message: AssistantEvent;
  conversationId?: string;
  seq?: number;
}

export interface SseEventConsumerDeps {
  /**
   * Commit-phase ref tracking the latest active conversation key.
   * Read on every envelope — required for correctness under
   * concurrent React (see module docstring).
   */
  activeConversationIdRef: { current: string | null };
  /** Dispatch the event into the chat domain's reducer. */
  handleStreamEvent: (event: AssistantEvent, epoch: number) => void;
  /** Reconcile the active conversation when a seq gap is detected. */
  reconcileActive: () => Promise<unknown>;
}

export interface SseEventConsumer {
  handleSseEvent(envelope: ConsumableEnvelope): void;
}

export function createSseEventConsumer(
  deps: SseEventConsumerDeps,
): SseEventConsumer {
  // Tracks in-flight gap reconciliation so we debounce rather than
  // firing O(N) reconcile calls while the first one is still pending.
  let reconcileInFlight = false;
  let latestGapSeq: number | null = null;

  return {
    handleSseEvent(envelope) {
      const event = envelope.message;
      const eventConversationId = envelope.conversationId;
      const eventSeq = envelope.seq;

      // Stage 1: connection-wide seq-gap detection. Runs on every
      // conversation-scoped event (any conversation) against the single
      // global cursor, before the active-conversation dispatch filter.
      let gapDeferred = false;
      if (eventSeq != null) {
        const stored = getReconnectCursor();
        if (stored === null) {
          // First event on a cold connection — seed the cursor without
          // reconciling. The monotonic advance below writes it.
        } else if (eventSeq < stored) {
          // Server seq counter restarted (daemon restart). Replace the
          // stale cursor and reconcile to pick up any state changes
          // from the restart.
          recordDiagnostic("sse_seq_generation_reset", {
            conversationId: eventConversationId,
            stored,
            observed: eventSeq,
          });
          replaceReconnectCursor(eventSeq);
          gapDeferred = true;
          // Fire-and-forget: cursor is already replaced above (the old
          // seq space is meaningless after a restart). Swallow rejection
          // to prevent unhandled-promise warnings.
          deps.reconcileActive().catch(() => {});
        } else if (eventSeq > stored + 1) {
          recordDiagnostic("sse_seq_gap_detected", {
            conversationId: eventConversationId,
            stored,
            observed: eventSeq,
            gap: eventSeq - stored,
          });
          gapDeferred = true;
          // Track the latest seq seen during a gap so the cursor jumps
          // to the right place when reconcile succeeds.
          latestGapSeq = eventSeq;
          if (!reconcileInFlight) {
            reconcileInFlight = true;
            const reconcileEpoch = useStreamStore.getState().streamEpoch;
            deps.reconcileActive()
              .then(() => {
                // Only advance if the epoch is still current. A stale
                // reconcile (SSE reconnected during the fetch) resolves
                // with empty — advancing would mark the gap as repaired
                // without authoritative data.
                if (
                  latestGapSeq != null &&
                  useStreamStore.getState().streamEpoch === reconcileEpoch
                ) {
                  replaceReconnectCursor(latestGapSeq);
                  latestGapSeq = null;
                }
              })
              .catch(() => {
                // Reconcile failed — cursor stays pinned so the next
                // event re-detects the gap and retries.
              })
              .finally(() => {
                reconcileInFlight = false;
              });
          }
        }
      }

      // Stage 2: dispatch filter. Global events pass through
      // unconditionally; conversation-scoped events need an exact match
      // against the active conversation.
      if (!isConversationScopedStreamEvent(event)) {
        deps.handleStreamEvent(event, useStreamStore.getState().streamEpoch);
      } else if (
        eventConversationId !== undefined &&
        eventConversationId === deps.activeConversationIdRef.current
      ) {
        // Idempotent apply: an event whose seq is at or below the
        // conversation's local seq has already been applied to
        // the transcript (a replay after reconnect, or overlap with an
        // in-flight reconcile). Re-applying would double-append deltas,
        // so skip it and leave the frontier untouched.
        const localSeq = getLocalSeq(eventConversationId);
        if (
          eventSeq != null &&
          localSeq != null &&
          eventSeq <= localSeq
        ) {
          recordDiagnostic("sse_event_seq_replayed", {
            conversationId: eventConversationId,
            eventType: event.type,
            eventSeq,
            localSeq,
          });
        } else {
          deps.handleStreamEvent(event, useStreamStore.getState().streamEpoch);
          // Advance the per-conversation frontier once the event is
          // applied so the snapshot/stream merge knows how far the
          // stream has carried this conversation, and so a later replay
          // of this seq is recognised as a no-op above.
          // `recordLocalSeq` ignores a null/undefined seq itself.
          recordLocalSeq(eventConversationId, eventSeq);
        }
      } else {
        recordDiagnostic("sse_event_wrong_conversation_filtered", {
          eventConversationId,
          activeConversationId: deps.activeConversationIdRef.current,
          eventType: event.type,
          reason: eventConversationId === undefined ? "missing" : "mismatch",
        });
      }

      // Advance the global cursor AFTER dispatch so a thrown handler
      // does not advance the cursor past unapplied work. Skip when a
      // gap was deferred — the generation-reset path replaced the
      // cursor synchronously; the seq-gap path defers advancement until
      // reconcile resolves. The cursor advances for filtered-out
      // (other-conversation) events too, so it stays contiguous with
      // the global counter for transport-level resume.
      if (eventSeq != null && !gapDeferred) {
        advanceReconnectCursor(eventSeq);
      }
    },
  };
}
