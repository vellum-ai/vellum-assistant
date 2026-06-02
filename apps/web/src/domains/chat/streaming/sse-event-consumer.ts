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
 *     stream. Fire a reconcile and defer cursor advancement until it
 *     resolves. While a reconcile is in-flight, subsequent gap events
 *     are debounced — only the latest seq is tracked. On success the
 *     cursor jumps to the latest seq; on failure it stays pinned so
 *     the next event retries.
 *   - On the normal (no-gap) path the cursor advances AFTER the
 *     handler returns. A thrown handler keeps the cursor pinned so the
 *     next event re-triggers the gap path.
 *
 * Reconnect handling:
 *   `clientSeq` resets to 1 on each new SSE subscription (the server
 *   creates a fresh counter map per subscriber). Callers must invoke
 *   `notifyReconnect()` on `sse.opened`. The consumer defers the
 *   actual reset until the first post-reconnect event arrives:
 *     - If the event carries `clientSeq` (new daemon): resets the
 *       seed flag, in-flight state, and gap tracker so the event
 *       re-seeds the cursor via `replaceLastSeenSeq`.
 *     - If the event uses raw `seq` (old daemon): no reset — `seq`
 *       is stable across connections and normal gap detection handles
 *       reconnect correctly (a jump means genuinely missed events).
 *
 *   Additionally, the seed event (first event from a newly created
 *   consumer) always uses `replaceLastSeenSeq` when `clientSeq` is
 *   present. This handles the case where SSE reconnected while this
 *   consumer was not mounted (e.g. user switched conversations) —
 *   `notifyReconnect()` was never called, but the server's counters
 *   still reset. `clientSeq` is inherently per-subscription, so the
 *   stored cursor from a prior subscription is stale. Raw `seq` keeps
 *   `setLastSeenSeq` (monotonic) on seed so that generation resets
 *   (daemon restart → seq drops) are detected on the next event.
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
  clientSeq?: number;
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
  /** Signal that an SSE reconnect occurred. The actual seq-tracking
   *  reset is deferred until the first post-reconnect event — only
   *  applied when `clientSeq` is present (resets per subscription).
   *  With raw `seq` (old daemon), gap detection proceeds normally. */
  notifyReconnect(): void;
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

  // Tracks in-flight gap reconciliation so we debounce rather than
  // firing O(N) reconcile calls while the first one is still pending.
  let reconcileInFlight = false;
  let latestGapSeq: { conversationId: string; seq: number } | null = null;

  // Set on sse.opened — deferred until the first post-reconnect
  // event so the reset only applies when clientSeq is present.
  let pendingReconnect = false;

  // Set when a reconnect is applied (clientSeq present). The first
  // post-reconnect write uses `replaceLastSeenSeq` (unconditional)
  // instead of `setLastSeenSeq` (monotonic, won't lower the cursor).
  let pendingReseed = false;

  return {
    notifyReconnect() {
      pendingReconnect = true;
    },
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

      // Prefer clientSeq (gap-free per subscriber) over raw seq
      // (global, may have gaps from targeted events the web client
      // never receives). Falls back to seq for older daemons that
      // predate the clientSeq field.
      const eventSeq = envelope.clientSeq ?? envelope.seq;
      let gapDetected = false;
      if (seqGapEnabled && eventSeq != null && eventConversationId) {
        // Deferred reconnect handling: clientSeq resets per
        // subscription, so reseed. Raw seq is stable across
        // connections — let normal gap detection handle it.
        if (pendingReconnect) {
          pendingReconnect = false;
          if (envelope.clientSeq != null) {
            seededSeqForConversation = false;
            reconcileInFlight = false;
            latestGapSeq = null;
            pendingReseed = true;
          }
        }
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
            gapDetected = true;
            // Track the latest seq seen during a gap so the cursor
            // jumps to the right place when reconcile succeeds.
            latestGapSeq = { conversationId: eventConversationId, seq: eventSeq };
            if (!reconcileInFlight) {
              reconcileInFlight = true;
              const reconcileEpoch = useStreamStore.getState().streamEpoch;
              deps.reconcileActive()
                .then(() => {
                  // Only advance if both the conversation and epoch are
                  // still current. A stale reconcile (user switched away,
                  // or SSE reconnected during the fetch) resolves with
                  // empty — advancing would mark the gap as repaired
                  // without authoritative data.
                  if (
                    latestGapSeq &&
                    deps.activeConversationIdRef.current === latestGapSeq.conversationId &&
                    useStreamStore.getState().streamEpoch === reconcileEpoch
                  ) {
                    replaceLastSeenSeq(latestGapSeq.conversationId, latestGapSeq.seq);
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
        } else {
          seededSeqForConversation = true;
          // clientSeq is per-subscription — the stored cursor might be
          // from a prior subscription that no longer matches. Use
          // unconditional replace so the seed always writes regardless
          // of the stored value (handles reconnect while unmounted).
          // Raw seq is stable: keep monotonic to preserve generation-
          // reset detection on the next event.
          if (envelope.clientSeq != null) {
            pendingReseed = true;
          }
        }
      }

      deps.handleStreamEvent(event, useStreamStore.getState().streamEpoch);

      // Advance the seq cursor AFTER the handler returns so a thrown
      // handler does not advance the cursor past unapplied work.
      // Skip advancement when a gap was detected — the counter-reset
      // path replaced the cursor synchronously; the seq-gap path
      // defers cursor advancement until reconcile resolves.
      if (
        seqGapEnabled &&
        eventSeq != null &&
        eventConversationId &&
        !gapDetected
      ) {
        if (pendingReseed) {
          replaceLastSeenSeq(eventConversationId, eventSeq);
          pendingReseed = false;
        } else {
          setLastSeenSeq(eventConversationId, eventSeq);
        }
      }
    },
  };
}
