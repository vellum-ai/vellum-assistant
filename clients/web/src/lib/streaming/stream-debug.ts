/**
 * Module-level SSE stream debugging tracker.
 *
 * Records every SSE event that flows through the stream transport layer
 * and maintains a lightweight registry of active and recently-ended stream
 * clients. Ended connections are retained (up to {@link MAX_ENDED_CLIENTS})
 * rather than deleted, so a reconnect bug can be diagnosed after the fact:
 * the per-connection `dataFrames`/`keepalives` counters of the connection
 * that stopped receiving events are exactly what splits a daemon delivery
 * bug (`keepalives > 0, dataFrames === 0`) from a client transport bug
 * (both `0`).
 *
 * Data is stored outside React state so it survives component unmounts and
 * can be inspected from the console via `window._vellumDebug.chat.events`.
 *
 * The event ring is also load-bearing: it retains each event's envelope
 * metadata (`seq`, `conversationId`, `emittedAt`) so a resync can replay the
 * recent tail onto a fresh snapshot (`getSseEnvelopesSince`) instead of
 * guessing whether the live view raced ahead of a lagging snapshot.
 */

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Why a stream client connection ended.
 *
 * - `"watchdog"` — the idle watchdog aborted the connection because no SSE
 *   traffic arrived within the configured window (silent stall).
 * - `"cancelled"` — the consumer cancelled the stream (e.g. teardown).
 * - `"error"` — the SDK surfaced a transport error.
 * - `"ended"` — the server closed the stream / the iterator completed
 *   without an abort or error.
 * - `"aborted"` — safety-net reason recorded when the abort signal fired
 *   but the transport never reported a more specific reason. Normally
 *   upgraded to one of the above by the transport's teardown path.
 */
export type SseClientEndReason =
  | "watchdog"
  | "cancelled"
  | "error"
  | "ended"
  | "aborted";

export interface SseDebugClient {
  /** Stable client identifier. */
  id: string;
  /** The AbortController signal for this client attempt. */
  abortSignal: AbortSignal;
  /** When the client was first registered (before the fetch started). */
  initiatedAt: number;
  /** When the first SSE data frame arrived (null until then). */
  establishedAt: number | null;
  /** Epoch ms of the last SSE frame of any kind (data OR heartbeat). */
  lastTrafficAt: number | null;
  /** Epoch ms of the last SSE *data* frame (excludes heartbeat comments). */
  lastDataAt: number | null;
  /** Count of SSE data frames seen on this client. */
  dataFrames: number;
  /** Count of heartbeat comment frames seen on this client. */
  keepalives: number;
  /** Epoch ms when the connection ended (null while still live). */
  endedAt: number | null;
  /** Why the connection ended (null while still live). */
  endReason: SseClientEndReason | null;
}

/**
 * A buffered event: the full backend envelope (so `seq` / `conversationId` /
 * `emittedAt` / `message` stay consistent with the wire type and the entry can
 * be replayed as-is) plus the client/timestamp this tracker stamps on receipt.
 */
export interface SseDebugEventEntry extends AssistantEventEnvelope {
  /** Which client produced this event. */
  clientId: string;
  /** ISO 8601 timestamp of when the event was received. */
  receivedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EVENTS = 1000;

/**
 * Upper bound on the number of *ended* clients retained for inspection.
 * Live clients are never evicted; once the ended-client count exceeds this
 * cap the oldest ended entries are dropped. ~15 covers a long burst of
 * reconnects while keeping the snapshot small enough to read in a console.
 */
const MAX_ENDED_CLIENTS = 15;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let nextClientId = 0;
/**
 * Insertion-ordered registry of stream clients, live and recently-ended.
 * Ended entries (`endedAt !== null`) are retained for post-hoc diagnosis
 * and evicted oldest-first once they exceed {@link MAX_ENDED_CLIENTS}.
 */
const clients = new Map<string, SseDebugClient>();
const events: SseDebugEventEntry[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a new stream client attempt. Called immediately when
 * {@link subscribeEvents} starts a new connection.
 */
export function registerSseClient(abortSignal: AbortSignal): string {
  const id = `sse-${++nextClientId}`;
  const client: SseDebugClient = {
    id,
    abortSignal,
    initiatedAt: Date.now(),
    establishedAt: null,
    lastTrafficAt: null,
    lastDataAt: null,
    dataFrames: 0,
    keepalives: 0,
    endedAt: null,
    endReason: null,
  };
  clients.set(id, client);
  evictEndedBeyondCap();

  // Safety net: the transport reports a precise end reason via
  // endSseClient in its teardown path. If it ever doesn't, still mark the
  // connection ended when its abort signal fires so the snapshot reflects
  // reality and bounded eviction can reclaim it.
  const onAbort = () => {
    endSseClient(id, "aborted");
  };
  if (abortSignal.aborted) {
    onAbort();
  } else {
    abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  return id;
}

/**
 * Mark a client as having received its first data frame. Called from the
 * `onSseEvent` callback inside {@link subscribeEvents}.
 */
export function markClientEstablished(clientId: string): void {
  const client = clients.get(clientId);
  if (client && client.establishedAt === null) {
    client.establishedAt = Date.now();
  }
}

/**
 * Record that an SSE frame arrived on a client. Called from the
 * `onSseEvent` callback inside {@link subscribeEvents} for every
 * parsed chunk, including heartbeat comment frames. `isData`
 * distinguishes data frames (yielded through the iterator) from
 * heartbeat comments (`data === undefined`), so a reader can tell
 * "bytes are flowing" apart from "the daemon is still keeping the
 * socket warm" — the fingerprint of a half-open connection.
 */
export function recordSseTraffic(clientId: string, isData: boolean): void {
  const client = clients.get(clientId);
  if (!client) {
    return;
  }
  const now = Date.now();
  client.lastTrafficAt = now;
  if (isData) {
    client.lastDataAt = now;
    client.dataFrames++;
  } else {
    client.keepalives++;
  }
}

/**
 * Push an event envelope into the ring buffer. Called from the `onEvent`
 * callback inside {@link subscribeEvents}. Retains the envelope metadata
 * (`id`/`conversationId`/`seq`/`emittedAt`) so the entry can be reconstituted
 * into an `AssistantEventEnvelope` for resync replay.
 */
export function pushSseEvent(
  clientId: string,
  envelope: AssistantEventEnvelope,
): void {
  events.push({ clientId, receivedAt: new Date().toISOString(), ...envelope });
  if (events.length > MAX_EVENTS) {
    events.shift();
  }
}

/**
 * Return a snapshot of all stream clients — live and recently-ended —
 * in registration order. Ended connections retain their final
 * `dataFrames`/`keepalives` counters and an `endReason`, so a reconnect
 * that stopped receiving events can be diagnosed alongside the live
 * connection that replaced it.
 */
export function getSseClients(): SseDebugClient[] {
  return Array.from(clients.values());
}

/**
 * Return the last N events (most recent last) with a cap of {@link MAX_EVENTS}.
 */
export function getSseEvents(limit = MAX_EVENTS): SseDebugEventEntry[] {
  const start = Math.max(0, events.length - limit);
  return events.slice(start);
}

/**
 * The buffered tail for one conversation with `seq > sinceSeq`, in ascending
 * seq order — the events to replay onto a fresh snapshot during resync. The
 * entries are envelopes already, so no reconstruction is needed.
 *
 * Returns `null` to signal "no safe replay — take the snapshot wholesale" when
 * either: there is no version anchor (`sinceSeq` null), or the ring no longer
 * covers the cursor. The ring evicts oldest-first ({@link MAX_EVENTS}), so its
 * retained entries are a seq-ordered suffix of the global stream; if the oldest
 * retained `seq` is newer than `sinceSeq + 1`, events between the cursor and the
 * buffer were evicted and a replay would silently apply a partial tail. Entries
 * without a numeric `seq` can't be ordered or gated and are skipped.
 */
export function getSseEnvelopesSince(
  conversationId: string,
  sinceSeq: number | null,
): AssistantEventEnvelope[] | null {
  if (sinceSeq === null) return null;

  // Does the ring still reach back to the cursor? `seq` is a single global
  // counter, so the oldest retained seq across ALL conversations is what proves
  // nothing between the cursor and the buffer was evicted.
  let oldestRetainedSeq = Infinity;
  for (const e of events) {
    if (typeof e.seq === "number") {
      oldestRetainedSeq = Math.min(oldestRetainedSeq, e.seq);
    }
  }
  if (oldestRetainedSeq !== Infinity && oldestRetainedSeq > sinceSeq + 1) {
    return null;
  }

  return events
    .filter(
      (e): e is SseDebugEventEntry & { seq: number } =>
        e.conversationId === conversationId &&
        typeof e.seq === "number" &&
        e.seq > sinceSeq,
    )
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Mark a client connection as ended, retaining it (with its final
 * counters) for post-hoc inspection instead of deleting it. Idempotent —
 * safe to call multiple times (for example from both the abort listener
 * and the transport's teardown path).
 *
 * The first call stamps `endedAt` and `endReason`. A later call only
 * upgrades the generic safety-net `"aborted"` reason to the precise one
 * the transport determined; it never overwrites an already-precise reason.
 */
export function endSseClient(
  clientId: string,
  reason: SseClientEndReason,
): void {
  const client = clients.get(clientId);
  if (!client) {
    return;
  }
  if (client.endedAt === null) {
    client.endedAt = Date.now();
    client.endReason = reason;
  } else if (client.endReason === "aborted" && reason !== "aborted") {
    client.endReason = reason;
  }
  evictEndedBeyondCap();
}

/**
 * Drop the oldest ended clients once their count exceeds
 * {@link MAX_ENDED_CLIENTS}. Live connections are never evicted. The
 * registry's insertion order means the oldest ended entries are dropped
 * first.
 */
function evictEndedBeyondCap(): void {
  let endedCount = 0;
  for (const client of clients.values()) {
    if (client.endedAt !== null) {
      endedCount++;
    }
  }
  if (endedCount <= MAX_ENDED_CLIENTS) {
    return;
  }
  for (const [id, client] of clients) {
    if (endedCount <= MAX_ENDED_CLIENTS) {
      break;
    }
    if (client.endedAt !== null) {
      clients.delete(id);
      endedCount--;
    }
  }
}

/**
 * Reset all module-level state. Intended for test isolation only.
 * @internal
 */
export function resetSseDebugStateForTests(): void {
  nextClientId = 0;
  clients.clear();
  events.length = 0;
}
