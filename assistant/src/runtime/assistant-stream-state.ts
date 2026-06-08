/**
 * Assistant Stream State -- a single per-assistant (per-daemon-process)
 * SSE sequence counter and ring buffer for `Last-Event-ID` replay.
 *
 * Every conversation-scoped outbound event picks up a monotonic `seq`
 * from one global counter shared across all conversations, and is pushed
 * onto one shared ring buffer. A reconnecting client presents the highest
 * `seq` it has applied; the daemon replays everything newer from the ring
 * -- re-applying the subscriber's targeting/scope filter -- then goes
 * live.
 *
 * A single global seq space means the reconnect cursor is one number, not
 * a per-conversation map: on one ordered SSE connection the client has
 * received a contiguous prefix of the global stream, so "highest seq
 * applied" is a valid resume point no matter how many conversations are
 * multiplexed on the connection.
 *
 * Bounds (oldest evicted first; first bound hit wins):
 * - Count: 200 events
 * - Total size: 256 KB
 * - Age: 30 seconds
 *
 * The ring is in-memory and per-daemon-process. After a daemon restart
 * the seq resets and reconnecting clients fall through to the snapshot
 * path. The ring is sized generously enough that a typical refresh
 * round-trip (~1-3s) is well within window.
 *
 * Persisted-seq map: alongside the live counter and ring, this module
 * tracks, per conversation, the `seq` of the last event whose content is
 * durably committed to the message rows (`persistedSeqByConversation`).
 * The `/messages` snapshot returns this value so a client can align the
 * snapshot with the stream: "these rows reflect all of this
 * conversation's events through `seq = S`." It is recorded at each
 * persistence flush (assistant rows persist incrementally, debounced, so
 * the snapshot can lag the live counter) -- never the live counter
 * itself, which would over-claim events that have streamed but not yet
 * been written. It shares the live counter's lifetime by design: both
 * are in-memory and reset together on restart, so a stored value can
 * never dangle against a fresh counter. The map is LRU-bounded; an
 * evicted conversation reports no seq and the client cold-starts.
 */

import type { AssistantEvent } from "./assistant-event.js";

// ── Tunables ─────────────────────────────────────────────────────────

const RING_COUNT_LIMIT = 200;
const RING_SIZE_LIMIT_BYTES = 256 * 1024;
const RING_AGE_LIMIT_MS = 30_000;

/**
 * Cap on how many conversations retain a persisted-seq entry. Unlike the
 * ring (which the live stream needs only briefly), the persisted-seq map
 * grows with the number of conversations that have ever streamed in this
 * process. Bound it LRU so it can't grow without limit; an evicted
 * conversation simply reports no seq on its next `/messages` and the
 * client cold-starts, which is harmless.
 */
const PERSISTED_SEQ_CONVERSATION_LIMIT = 1024;

// ── Types ────────────────────────────────────────────────────────────

/**
 * Targeting / exclusion modifiers attached to an event at publish time.
 * Stored on ring entries so replay can re-apply the same delivery
 * filter that the live `publish()` path used.
 *
 * Fields use plain `string` rather than branded channel types so
 * this module stays independent of the `channels/` package.
 */
export interface EventTargeting {
  targetCapability?: string;
  targetClientId?: string;
  targetInterfaceId?: string;
  excludeClientId?: string;
}

/**
 * Identity of the subscriber requesting a replay window. Replay
 * filtering mirrors the live `publish()` logic in `AssistantEventHub`:
 * targeted entries are only delivered when the subscriber matches.
 */
export interface ReplaySubscriber {
  type: "client" | "process";
  clientId?: string;
  interfaceId?: string;
  capabilities?: readonly string[];
}

interface RingEntry {
  seq: number;
  event: AssistantEvent;
  emittedAt: number;
  sizeBytes: number;
  targeting?: EventTargeting;
}

interface AssistantStreamState {
  nextSeq: number;
  ring: RingEntry[];
  totalSizeBytes: number;
  /**
   * Per-conversation `seq` of the last event durably committed to the
   * message rows. Insertion order is maintained as an LRU recency list:
   * the oldest key is evicted first once the map exceeds
   * {@link PERSISTED_SEQ_CONVERSATION_LIMIT}.
   */
  persistedSeqByConversation: Map<string, number>;
}

// ── State ────────────────────────────────────────────────────────────

const state: AssistantStreamState = {
  nextSeq: 1,
  ring: [],
  totalSizeBytes: 0,
  persistedSeqByConversation: new Map(),
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Assign a monotonic global `seq` to a conversation-scoped event and push
 * it onto the ring buffer. No-op when `event.conversationId` is absent
 * (unscoped broadcasts are never replayable).
 *
 * When `options.targeting` is provided, the metadata is stored on the
 * ring entry so that {@link getReplayWindow} can re-apply the same
 * delivery filter at replay time. This keeps targeted events in the
 * ring (preventing false-positive seq gaps on reconnect) without
 * leaking them to subscribers outside their intended delivery set.
 *
 * Mutates `event.seq` in place.
 */
export function stampAndBuffer(
  event: AssistantEvent,
  options?: { targeting?: EventTargeting },
): void {
  if (event.conversationId == null) return;

  event.seq = state.nextSeq++;

  // Approximate size by serialized JSON length. This is the same
  // bytes-on-wire we'll send, so it tracks ring memory pressure
  // closely without a separate measurement pass.
  const sizeBytes = JSON.stringify(event).length;
  const entry: RingEntry = {
    seq: event.seq,
    event,
    emittedAt: Date.now(),
    sizeBytes,
  };
  if (options?.targeting) {
    entry.targeting = options.targeting;
  }
  state.ring.push(entry);
  state.totalSizeBytes += sizeBytes;

  evict();
}

/**
 * Replay events with `seq > lastSeenSeq` from the single global ring.
 * Returns `null` when the requested cursor is older than the oldest
 * buffered entry -- callers should fall back to a snapshot resync.
 *
 * When `subscriber` is provided, entries carrying targeting metadata
 * are filtered using the same rules as the live `publish()` path in
 * `AssistantEventHub`, so targeted events do not leak to subscribers
 * outside their intended delivery set on reconnect.
 *
 * When `conversationId` is provided, only that conversation's events are
 * returned -- a conversation-scoped subscription only delivers its own
 * conversation live, so replaying any other conversation's gap would
 * push events the client will never receive again live.
 *
 * Sweeps age-expired entries at read time so an idle stream cannot serve
 * stale deltas past the 30-second window (eviction otherwise only runs on
 * `stampAndBuffer`).
 */
export function getReplayWindow(
  lastSeenSeq: number,
  subscriber?: ReplaySubscriber,
  conversationId?: string,
): readonly AssistantEvent[] | null {
  evict();

  if (state.ring.length === 0) return [];

  const oldest = state.ring[0]?.seq ?? Infinity;
  if (lastSeenSeq < oldest - 1) return null;

  return state.ring
    .filter(
      (entry) =>
        entry.seq > lastSeenSeq &&
        (conversationId == null ||
          entry.event.conversationId === conversationId) &&
        (subscriber == null || matchesSubscriber(entry, subscriber)),
    )
    .map((entry) => entry.event);
}

/**
 * Current high-water `seq` -- the value last assigned by
 * {@link stampAndBuffer}, or `0` when nothing has been stamped yet in
 * this process.
 *
 * Read synchronously right after emitting an event to learn that event's
 * `seq`: `stampAndBuffer` runs inline on the publish path (before the
 * async fanout), so no other event can interleave between the emit
 * returning and this read on the single-threaded event loop.
 */
export function getCurrentSeq(): number {
  return state.nextSeq - 1;
}

/**
 * Record that conversation `conversationId` has durably persisted all of
 * its events through `seq`. Called at each persistence flush with the
 * `seq` of the last event whose content the write committed.
 *
 * Monotonic: a lower `seq` never regresses a higher one (out-of-order
 * async commits are clamped). LRU-bounded by
 * {@link PERSISTED_SEQ_CONVERSATION_LIMIT}: re-recording refreshes
 * recency, and the oldest conversation is evicted once the cap is
 * exceeded. Non-positive or non-finite `seq` values are ignored.
 */
export function recordPersistedSeq(conversationId: string, seq: number): void {
  if (!Number.isFinite(seq) || seq <= 0) return;

  const map = state.persistedSeqByConversation;
  const prev = map.get(conversationId);
  if (prev !== undefined) {
    // Re-insert to move this key to the most-recently-used end.
    map.delete(conversationId);
    map.set(conversationId, Math.max(prev, seq));
    return;
  }

  map.set(conversationId, seq);
  if (map.size > PERSISTED_SEQ_CONVERSATION_LIMIT) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
}

/**
 * Highest `seq` durably persisted for `conversationId`, or `null` when
 * none has been recorded in this process (cold conversation, or evicted
 * from the LRU map). Returned by `/messages` so a client can align the
 * snapshot with the live stream.
 */
export function getPersistedSeq(conversationId: string): number | null {
  return state.persistedSeqByConversation.get(conversationId) ?? null;
}

/**
 * Reset all stream state. Test-only.
 */
export function _resetStreamStateForTesting(): void {
  state.nextSeq = 1;
  state.ring = [];
  state.totalSizeBytes = 0;
  state.persistedSeqByConversation.clear();
}

/**
 * Read-only inspector for tests.
 */
export function _peekStreamForTesting(): {
  nextSeq: number;
  ringLength: number;
  totalSizeBytes: number;
  oldestSeq: number | null;
  newestSeq: number | null;
} {
  return {
    nextSeq: state.nextSeq,
    ringLength: state.ring.length,
    totalSizeBytes: state.totalSizeBytes,
    oldestSeq: state.ring[0]?.seq ?? null,
    newestSeq: state.ring[state.ring.length - 1]?.seq ?? null,
  };
}

// ── Internals ────────────────────────────────────────────────────────

/**
 * Mirrors the delivery logic in `AssistantEventHub.publish()`. Returns
 * `true` when `subscriber` would have received the entry during live
 * fanout.
 */
function matchesSubscriber(
  entry: RingEntry,
  subscriber: ReplaySubscriber,
): boolean {
  const t = entry.targeting;
  if (!t) return true;

  // Self-echo suppression: the originating client never receives the
  // event back.
  if (
    t.excludeClientId != null &&
    subscriber.type === "client" &&
    subscriber.clientId === t.excludeClientId
  ) {
    return false;
  }

  // Interface targeting: only clients of the requested interface.
  if (t.targetInterfaceId != null) {
    if (
      subscriber.type !== "client" ||
      subscriber.interfaceId !== t.targetInterfaceId
    ) {
      return false;
    }
  }

  if (t.targetClientId != null) {
    // Client targeting: bypass conversation filter, deliver only to the
    // named client.
    if (
      subscriber.type !== "client" ||
      subscriber.clientId !== t.targetClientId
    ) {
      return false;
    }
    if (
      t.targetCapability != null &&
      !subscriber.capabilities?.includes(t.targetCapability)
    ) {
      return false;
    }
    return true;
  }

  // Capability targeting (without client targeting): only subscribers
  // that declare the required capability.
  if (t.targetCapability != null) {
    if (
      subscriber.type !== "client" ||
      !subscriber.capabilities?.includes(t.targetCapability)
    ) {
      return false;
    }
  }

  return true;
}

function evict(): void {
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
