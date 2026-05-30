/**
 * Conversation Stream State -- per-conversation SSE sequence counter and
 * ring buffer for `Last-Event-ID` replay (B7 Unit 1).
 *
 * Every conversation-scoped outbound event picks up a monotonic `seq`
 * number from this module. The same event is also pushed onto a bounded
 * ring buffer so a reconnecting client can request replay of events the
 * daemon emitted while it was disconnected.
 *
 * Bounds (oldest evicted first; first bound hit wins):
 * - Count: 200 events
 * - Total size: 256 KB
 * - Age: 30 seconds
 *
 * The ring is in-memory and per-daemon-process. After a daemon restart
 * all seqs reset and reconnecting clients fall through to the snapshot
 * path (delivered by B7 Unit 2). The ring is sized generously enough
 * that a typical refresh round-trip (~1-3s) is well within window.
 */

import type { AssistantEvent } from "./assistant-event.js";

// ── Tunables ─────────────────────────────────────────────────────────

const RING_COUNT_LIMIT = 200;
const RING_SIZE_LIMIT_BYTES = 256 * 1024;
const RING_AGE_LIMIT_MS = 30_000;

// ── Types ────────────────────────────────────────────────────────────

interface RingEntry {
  seq: number;
  event: AssistantEvent;
  emittedAt: number;
  sizeBytes: number;
}

interface ConversationStreamState {
  nextSeq: number;
  ring: RingEntry[];
  totalSizeBytes: number;
}

// ── State ────────────────────────────────────────────────────────────

const streams = new Map<string, ConversationStreamState>();

function getOrCreate(conversationId: string): ConversationStreamState {
  let state = streams.get(conversationId);
  if (!state) {
    state = { nextSeq: 1, ring: [], totalSizeBytes: 0 };
    streams.set(conversationId, state);
  }
  return state;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Assign a monotonic `seq` to a conversation-scoped event and (when
 * replayable) push it onto the ring buffer. No-op when
 * `event.conversationId` is absent (unscoped broadcasts are never
 * replayable).
 *
 * `options.replayable` should be `false` whenever the event was
 * published with any targeting / exclusion modifier
 * (`targetCapability`, `targetClientId`, `targetInterfaceId`,
 * `excludeClientId`). Such events have a narrower delivery set than the
 * conversation subscriber list, so storing them by `conversationId`
 * alone would leak them to the wrong subscribers on replay. The seq is
 * still stamped so the wire-side ordering stays contiguous; only the
 * ring push is skipped. Defaults to `true`.
 *
 * Mutates `event.seq` in place.
 */
export function stampAndBuffer(
  event: AssistantEvent,
  options?: { replayable?: boolean },
): void {
  const cid = event.conversationId;
  if (cid == null) return;

  const state = getOrCreate(cid);
  event.seq = state.nextSeq++;

  if (options?.replayable === false) return;

  // Approximate size by serialized JSON length. This is the same
  // bytes-on-wire we'll send, so it tracks ring memory pressure
  // closely without a separate measurement pass.
  const sizeBytes = JSON.stringify(event).length;
  state.ring.push({ seq: event.seq, event, emittedAt: Date.now(), sizeBytes });
  state.totalSizeBytes += sizeBytes;

  evict(state);
}

/**
 * Replay events with `seq > lastSeenSeq` for a given conversation.
 * Returns `null` when the requested cursor is older than the oldest
 * buffered entry -- callers should fall back to a snapshot resync.
 *
 * Sweeps age-expired entries at read time so an idle conversation
 * cannot serve stale deltas past the 30-second window (eviction
 * only runs on `stampAndBuffer`, so without this an idle stream
 * would retain its tail until the next write). When the sweep
 * drains the ring entirely, the conversation's state entry is
 * dropped to keep the global map from growing unboundedly with
 * inactive conversations.
 */
export function getReplayWindow(
  conversationId: string,
  lastSeenSeq: number,
): readonly AssistantEvent[] | null {
  const state = streams.get(conversationId);
  if (!state) return [];

  evict(state);

  if (state.ring.length === 0) {
    streams.delete(conversationId);
    return [];
  }

  const oldest = state.ring[0]?.seq ?? Infinity;
  if (lastSeenSeq < oldest - 1) return null;

  return state.ring
    .filter((entry) => entry.seq > lastSeenSeq)
    .map((entry) => entry.event);
}

/**
 * Drop all state for a conversation. Currently unused -- the ring
 * self-evicts by age -- but exposed for explicit dispose flows
 * (e.g. when a conversation is deleted).
 */
export function clearConversationStream(conversationId: string): void {
  streams.delete(conversationId);
}

/**
 * Reset all stream state. Test-only.
 */
export function _resetConversationStreamsForTesting(): void {
  streams.clear();
}

/**
 * Read-only inspector for tests.
 */
export function _peekStreamForTesting(conversationId: string): {
  nextSeq: number;
  ringLength: number;
  totalSizeBytes: number;
  oldestSeq: number | null;
  newestSeq: number | null;
} | null {
  const state = streams.get(conversationId);
  if (!state) return null;
  return {
    nextSeq: state.nextSeq,
    ringLength: state.ring.length,
    totalSizeBytes: state.totalSizeBytes,
    oldestSeq: state.ring[0]?.seq ?? null,
    newestSeq: state.ring[state.ring.length - 1]?.seq ?? null,
  };
}

// ── Internals ────────────────────────────────────────────────────────

function evict(state: ConversationStreamState): void {
  const now = Date.now();
  while (state.ring.length > 0) {
    const head = state.ring[0];
    if (head == null) break;

    const overCount = state.ring.length > RING_COUNT_LIMIT;
    const overSize = state.totalSizeBytes > RING_SIZE_LIMIT_BYTES;
    const overAge = now - head.emittedAt > RING_AGE_LIMIT_MS;

    if (!overCount && !overSize && !overAge) break;

    state.ring.shift();
    state.totalSizeBytes -= head.sizeBytes;
  }
}
