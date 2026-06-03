/**
 * Conversation-scoped consumer of `sse.event` envelopes.
 *
 * The bus delivers every event from a single unfiltered SSE
 * connection. This module applies the two-stage filter that keeps
 * cross-conversation events from leaking, runs seq-gap detection (and
 * triggers a reconcile when a gap is observed), and dispatches the
 * surviving events to the caller's handler.
 *
 * Cross-conversation filter:
 *   1. Global events (`sync_changed`, `home_feed_updated`, etc.) are
 *      not tied to a conversation — always pass through.
 *   2. Conversation-scoped events must have an explicit
 *      `conversationId` matching the current active conversation.
 *      Events whose conversationId is missing or mismatched are
 *      dropped: a missing id is treated as "unknown conversation"
 *      rather than "broadcast," because under the bus-owned
 *      unfiltered SSE there is no per-conversation subscription URL
 *      to fall back to for routing.
 *
 * The active-conversation key is read from a ref the caller updates
 * in the commit phase — see `use-event-stream.ts`. The ref pattern
 * lets an `assistant_text_delta` published in the gap between a
 * conversation switch and the effect cleanup get rejected as soon as
 * React commits the new active key. A direct closure capture would
 * leak deltas into the new conversation until the cleanup ran.
 *
 * Seq-gap detection (feature-flagged via `isSeqGapDetectionEnabled`):
 *   - The first event after a conversation switch seeds the cursor
 *     without reconciling — prevents spurious refetches when a stored
 *     cursor is stale relative to the server (e.g. stored=50, server
 *     at seq=500 after a daemon restart).
 *   - Subsequent events whose seq < stored: server-side counter
 *     restarted (daemon restart). Replace the stale cursor and
 *     reconcile.
 *   - Subsequent events whose seq > stored + 1: gap in the live
 *     stream. Reconcile to fetch the missed events.
 *   - The cursor only advances AFTER the handler returns and only
 *     when no gap was detected. A thrown handler keeps the cursor
 *     pinned so the next event re-triggers the gap path.
 */

import { useStreamStore } from "@/domains/chat/stream-store";
import { isConversationScopedStreamEvent } from "@/domains/chat/utils/chat";
import { recordDiagnostic } from "@/lib/diagnostics";
import { isSeqGapDetectionEnabled } from "@/lib/feature-flags/seq-gap-detection-flag";
import {
  getLastSeenSeq,
  replaceLastSeenSeq,
  setLastSeenSeq,
} from "@/lib/streaming/last-seen-seq";
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
  reconcileActive: () => void;
}

export interface SseEventConsumer {
  handleSseEvent(envelope: ConsumableEnvelope): void;
}

export function createSseEventConsumer(
  deps: SseEventConsumerDeps,
): SseEventConsumer {
  // Read the feature-flag once at construction — it requires a reload
  // to flip, so it cannot change during the lifetime of one
  // conversation subscription.
  const seqGapEnabled = isSeqGapDetectionEnabled();

  // Gate so the very first event after a conversation switch seeds
  // the seq cursor without triggering a reconcile.
  let seededSeqForConversation = false;

  return {
    handleSseEvent(envelope) {
      const event = envelope.message;
      const eventConversationId = envelope.conversationId;

      // Stage 1: global events pass through unconditionally.
      if (!isConversationScopedStreamEvent(event)) {
        deps.handleStreamEvent(event, useStreamStore.getState().streamEpoch);
        return;
      }
      // Stage 2: conversation-scoped events need an exact match.
      if (
        eventConversationId === undefined ||
        eventConversationId !== deps.activeConversationIdRef.current
      ) {
        recordDiagnostic("sse_event_wrong_conversation_filtered", {
          eventConversationId,
          activeConversationId: deps.activeConversationIdRef.current,
          eventType: event.type,
          reason: eventConversationId === undefined ? "missing" : "mismatch",
        });
        return;
      }

      const eventSeq = envelope.seq;
      let gapDetected = false;
      if (seqGapEnabled && eventSeq != null && eventConversationId) {
        if (seededSeqForConversation) {
          const stored = getLastSeenSeq(eventConversationId) ?? 0;
          if (eventSeq < stored) {
            // Server seq counter restarted (daemon restart). Replace
            // the stale cursor and reconcile to pick up any state
            // changes from the restart.
            recordDiagnostic("sse_seq_generation_reset", {
              conversationId: eventConversationId,
              stored,
              observed: eventSeq,
            });
            replaceLastSeenSeq(eventConversationId, eventSeq);
            gapDetected = true;
            deps.reconcileActive();
          } else if (eventSeq > stored + 1) {
            recordDiagnostic("sse_seq_gap_detected", {
              conversationId: eventConversationId,
              stored,
              observed: eventSeq,
              gap: eventSeq - stored,
            });
            gapDetected = true;
            deps.reconcileActive();
          }
        } else {
          seededSeqForConversation = true;
        }
      }

      deps.handleStreamEvent(event, useStreamStore.getState().streamEpoch);

      // Advance the seq cursor AFTER the handler returns so a thrown
      // handler does not advance the cursor past unapplied work.
      // Skip advancement when a gap was detected — the reconcile
      // refetch will deliver authoritative state. If reconcile fails,
      // the next contiguous event will re-detect the gap and retry.
      if (
        seqGapEnabled &&
        eventSeq != null &&
        eventConversationId &&
        !gapDetected
      ) {
        setLastSeenSeq(eventConversationId, eventSeq);
      }
    },
  };
}
