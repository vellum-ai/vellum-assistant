/**
 * Conversation-scoped consumer of `sse.event` envelopes.
 *
 * The bus delivers every event from a single unfiltered SSE
 * connection. This module runs connection-wide seq-gap detection (and
 * triggers an authoritative reconcile only when a gap large enough to
 * prove ring eviction is observed), applies
 * the cross-conversation filter that keeps other conversations' events
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
 *   - An event whose seq > cursor + 1: a discontinuity. Whether it is a
 *     benign withheld-event skip or a real out-of-ring loss is decided
 *     against BOTH ring bounds. Live delivery is concurrent with stamping,
 *     so a connected subscriber never relies on the ring; the ring matters
 *     only across a delivery gap, where it backfills up to
 *     `SSE_REPLAY_RING_COUNT_LIMIT` events, none older than
 *     `SSE_REPLAY_RING_AGE_LIMIT_MS`. The gap is benign — left contiguous,
 *     event dispatched, cursor advanced, no reconcile — only when the seq
 *     delta is under the count bound AND the last event arrived within the
 *     age window (so the global seq merely skipped events the hub withheld
 *     from this subscriber: self-echo-suppressed `sync_changed`,
 *     capability-targeted host-proxy events). Otherwise — a delta past the
 *     count bound, or a connection quiet longer than the age window — the
 *     skipped events may have been evicted (count, byte, or age), so fire
 *     an authoritative reconcile of the active conversation: it reloads
 *     `/messages` and takes the durable server snapshot wholesale. The
 *     reconcile is debounced while one is in flight so a burst of gap
 *     events fires a single fetch. The cursor advance is deferred until the
 *     reconcile resolves: on success it jumps to the live frontier (the
 *     hole is healed by the snapshot, not replayed) so the same gap is not
 *     re-detected on every following event; on failure it stays pinned so
 *     the next event re-detects the gap and retries the heal rather than
 *     stranding the hole until the next reconnect.
 *   - On the normal (no-gap) path the cursor advances AFTER the
 *     handler returns. A thrown handler keeps the cursor pinned so the
 *     next event re-triggers the gap path. The generation-reset path
 *     replaces the cursor synchronously and defers the post-dispatch
 *     advance.
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
 *   daemon goes live from a higher seq and gap detection reconciles
 *   authoritatively from `/messages`.
 */

import {
  SSE_REPLAY_RING_AGE_LIMIT_MS,
  SSE_REPLAY_RING_COUNT_LIMIT,
} from "@vellumai/assistant-api";

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
  /**
   * Clock used to measure how long the connection has been quiet, for the
   * age dimension of benign-gap detection. Defaults to `Date.now`;
   * injectable so tests can drive the replay-ring age window
   * deterministically.
   */
  now?: () => number;
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
  // Highest seq observed while a gap heal is pending. The cursor advance
  // is deferred until the heal resolves: on success it jumps here so the
  // same gap is not re-detected on every following event; on failure the
  // cursor stays pinned so the next event re-detects the gap and retries.
  let gapFrontier: number | null = null;
  // Timestamp of the last seq-carrying event delivered on this connection,
  // used as the age dimension of benign-gap detection: a quiet stretch
  // longer than the ring's age window means a gap could be unrecoverable
  // by replay. Zero until the first event so the cold-start seed below
  // never reads a stale value.
  let lastEventAtMs = 0;
  const now = deps.now ?? Date.now;

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
        const nowMs = now();
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
          // A seq discontinuity. The global per-assistant `seq` is stamped
          // before fanout, but the hub deliberately withholds some events
          // from a given subscriber — self-echo-suppressed `sync_changed`
          // (a client's own mutation echo) and capability-targeted
          // host-proxy events — so the cursor legitimately skips seqs this
          // client was never going to receive.
          //
          // Live delivery is concurrent with stamping: a connected
          // subscriber receives every event as it is published and never
          // relies on the ring, so a gap on a healthy live stream can only
          // be such a withheld event — benign. The ring matters only across
          // a delivery gap (a disconnect/resume), where it backfills only
          // what it still holds: up to `SSE_REPLAY_RING_COUNT_LIMIT` events,
          // none older than `SSE_REPLAY_RING_AGE_LIMIT_MS`. So the hole is
          // provably recoverable — and the gap therefore benign — only when
          // BOTH bounds say replay could have covered it: the seq delta is
          // under the count bound AND we last received an event within the
          // age window (any delivery gap was short enough that nothing we
          // missed has aged out). Otherwise the ring may have dropped events
          // between the durable snapshot and the live stream (count-, byte-,
          // or age-eviction), so heal authoritatively rather than wave the
          // gap through and strand the missing events until a manual reload.
          const idleMs = nowMs - lastEventAtMs;
          const replayCouldHaveCovered =
            eventSeq - stored < SSE_REPLAY_RING_COUNT_LIMIT &&
            idleMs < SSE_REPLAY_RING_AGE_LIMIT_MS;
          if (replayCouldHaveCovered) {
            // Benign: fall through (no `gapDeferred`) so the cursor advances
            // and the event dispatches as contiguous. Firing an
            // authoritative heal here would race debounced `/messages`
            // persistence and could clobber freshly-streamed content — the
            // "last message only appears after a refresh" bug.
            recordDiagnostic("sse_seq_gap_benign", {
              conversationId: eventConversationId,
              stored,
              observed: eventSeq,
              gap: eventSeq - stored,
              idleMs,
            });
          } else {
            // Out-of-ring gap: the seq delta exceeds the count bound, or the
            // connection was quiet longer than the ring's age window, so the
            // skipped events may have been evicted and the live suffix is
            // non-contiguous. Heal the hole with an authoritative reconcile
            // that reloads `/messages` and takes the server snapshot
            // wholesale.
            //
            // The cursor advance is deferred to the reconcile's outcome
            // (`gapDeferred` skips the post-dispatch advance below): on
            // success the cursor jumps to the live frontier so the same gap
            // is not re-detected on every following event; on failure it
            // stays pinned at `stored` so the next event re-detects the gap
            // and retries the heal instead of stranding the hole until the
            // next reconnect. A burst of gap events while one heal is in
            // flight is debounced to a single fetch and a single diagnostic,
            // and the deferred advance tracks the latest frontier seen.
            gapDeferred = true;
            gapFrontier = eventSeq;
            if (!reconcileInFlight) {
              recordDiagnostic("sse_seq_gap_detected", {
                conversationId: eventConversationId,
                stored,
                observed: eventSeq,
                gap: eventSeq - stored,
                idleMs,
              });
              reconcileInFlight = true;
              deps
                .reconcileActive()
                .then(() => {
                  if (gapFrontier != null) {
                    advanceReconnectCursor(gapFrontier);
                  }
                })
                .catch(() => {})
                .finally(() => {
                  gapFrontier = null;
                  reconcileInFlight = false;
                });
            }
          }
        }

        // Record connection liveness for the age dimension above. Updated
        // for every seq-carrying event (seeded, contiguous, reset, or gap)
        // so the next event's idle measurement reflects the true delivery
        // gap on this connection.
        lastEventAtMs = nowMs;
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
      // does not advance the cursor past unapplied work. Skip when an
      // advance was deferred: the generation-reset path replaced the
      // cursor synchronously, and the seq-gap path advances only once its
      // authoritative reconcile resolves (so a failed heal leaves the
      // cursor pinned and the gap is retried). The cursor advances for
      // filtered-out (other-conversation) events too, so it stays
      // contiguous with the global counter for transport-level resume.
      if (eventSeq != null && !gapDeferred) {
        advanceReconnectCursor(eventSeq);
      }
    },
  };
}
