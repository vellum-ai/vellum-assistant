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
 * Gap detection runs on `clientSeq` — the daemon's subscriber-filtered,
 * per-conversation sequence number. It is gap-free by construction
 * (counts only events the subscriber is eligible to receive), so a jump
 * of more than one signals genuinely missed events. The global `seq` is
 * not used here; it can skip values for targeted events the web client
 * never receives, which would produce false gaps. (`seq` drives the
 * transport-level reconnect cursor instead — see `reconnect-cursor.ts`.)
 *
 * Seq-gap detection (feature-flagged via `isSeqGapDetectionEnabled`):
 *   - The first event after a conversation switch seeds the watermark
 *     without reconciling — `clientSeq` is per-subscription, so a
 *     watermark left from a prior subscription is meaningless.
 *   - Subsequent events whose clientSeq < watermark: the subscriber's
 *     counter reset without a reconnect signal (a missed `sse.opened`).
 *     Replace the stale watermark and reconcile.
 *   - Subsequent events whose clientSeq > watermark + 1: gap in the
 *     live stream. Fire a reconcile and defer watermark advancement
 *     until it resolves. While a reconcile is in-flight, subsequent gap
 *     events are debounced — only the latest seq is tracked. On success
 *     the watermark jumps to the latest seq; on failure it stays pinned
 *     so the next event retries.
 *   - On the normal (no-gap) path the watermark advances AFTER the
 *     handler returns. A thrown handler keeps it pinned so the next
 *     event re-triggers the gap path.
 *
 * Reconnect handling:
 *   `clientSeq` resets to 1 on each new SSE subscription (the daemon
 *   creates a fresh counter per subscriber). Callers must invoke
 *   `notifyReconnect()` on `sse.opened`; the consumer defers the reset
 *   until the first post-reconnect event, which re-seeds the watermark
 *   via `replaceLastSeenSeq`.
 *
 *   The seed event (first event from a newly created consumer) also
 *   re-seeds unconditionally via `replaceLastSeenSeq`. This handles a
 *   reconnect that happened while this consumer was unmounted (e.g.
 *   user switched conversations) — `notifyReconnect()` was never
 *   called, but the subscriber counter still reset.
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
   *  reset is deferred until the first post-reconnect event, which
   *  re-seeds the per-conversation `clientSeq` watermark. */
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

  // Set on sse.opened — deferred until the first post-reconnect event
  // so the watermark re-seeds from the new subscription's clientSeq.
  let pendingReconnect = false;

  // Set when a re-seed is pending. The next write uses
  // `replaceLastSeenSeq` (unconditional) instead of `setLastSeenSeq`
  // (monotonic, won't lower the watermark).
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

      // Gap detection uses clientSeq only — the daemon's gap-free
      // per-conversation per-subscriber counter. The global seq can
      // skip values for targeted events the web client never receives
      // and would produce false gaps here.
      const eventSeq = envelope.clientSeq;
      let gapDetected = false;
      if (seqGapEnabled && eventSeq != null && eventConversationId) {
        // Deferred reconnect handling: clientSeq resets per
        // subscription, so re-seed from the first post-reconnect event.
        if (pendingReconnect) {
          pendingReconnect = false;
          seededSeqForConversation = false;
          reconcileInFlight = false;
          latestGapSeq = null;
          pendingReseed = true;
        }
        if (seededSeqForConversation) {
          const stored = getLastSeenSeq(eventConversationId) ?? 0;
          if (eventSeq < stored) {
            // The subscriber's clientSeq counter reset without a
            // reconnect signal (a missed sse.opened). Replace the
            // stale watermark and reconcile to pick up missed state.
            recordDiagnostic("sse_seq_generation_reset", {
              conversationId: eventConversationId,
              stored,
              observed: eventSeq,
            });
            replaceLastSeenSeq(eventConversationId, eventSeq);
            gapDetected = true;
            // Fire-and-forget: watermark is already replaced above (the
            // old counter space is meaningless after a reset). Swallow
            // rejection to prevent unhandled-promise warnings.
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
          // clientSeq is per-subscription — a watermark left from a
          // prior subscription is meaningless. Re-seed unconditionally
          // so the seed always writes regardless of the stored value
          // (handles a reconnect that happened while unmounted).
          pendingReseed = true;
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
