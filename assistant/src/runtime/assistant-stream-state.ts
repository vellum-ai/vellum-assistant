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
 * The ring is in-memory and per-daemon-process, but the seq counter
 * itself survives restarts: blocks of seq values are reserved ahead of
 * use and the reserved ceiling is persisted to the workspace
 * (`data/stream-seq.json`), so a restarted daemon resumes stamping
 * above every seq the previous process could have emitted. Clients
 * therefore never observe the counter moving backwards — a restart
 * shows up as (at most) a bounded forward gap, which the normal
 * gap-reconcile / snapshot-resync path already handles. The ring is
 * sized generously enough that a typical refresh round-trip (~1-3s)
 * is well within window.
 *
 * Persisted seq: alongside the live counter and ring, the `seq` of the last
 * event whose content is durably committed to a conversation's message rows
 * is stored on the `conversations.seq` column (see `conversation-crud`). The
 * `/messages` snapshot returns it so a client can align the snapshot with the
 * stream: "these rows reflect all of this conversation's events through
 * `seq = S`." It is written at each persistence flush (assistant rows persist
 * incrementally, debounced, so the snapshot can lag the live counter) -- never
 * the live counter itself, which would over-claim events that have streamed
 * but not yet been written. Because it lives in the database it survives a
 * restart; and because the counter resumes above the persisted reservation, a
 * value written by a previous process could only ever be lower than any seq
 * the new process assigns -- never ambiguous against it.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  SSE_REPLAY_RING_AGE_LIMIT_MS,
  SSE_REPLAY_RING_COUNT_LIMIT,
} from "../api/constants/sse-replay.js";
import { getWorkspaceDir } from "../util/platform.js";
import type { AssistantEvent } from "./assistant-event.js";

// ── Tunables ─────────────────────────────────────────────────────────

// Count and age bounds on the replay ring. Shared with the web client
// (via `@vellumai/assistant-api`) so its seq-gap tolerance is sized
// against the same numbers the daemon buffers against.
const RING_COUNT_LIMIT = SSE_REPLAY_RING_COUNT_LIMIT;
const RING_SIZE_LIMIT_BYTES = 256 * 1024;
const RING_AGE_LIMIT_MS = SSE_REPLAY_RING_AGE_LIMIT_MS;

/**
 * How many seq values are reserved per persisted write. The counter can
 * hand out seqs up to the persisted ceiling without touching disk, so
 * the file is written once per block rather than once per event. A
 * restart skips at most one block's worth of unused seqs — a bounded
 * forward gap that clients already treat as a missed-events signal.
 */
const SEQ_RESERVATION_BLOCK = 1024;

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
  /**
   * Highest seq this process may assign without persisting a new
   * reservation. `0` until the first stamp loads (or creates) the
   * persisted reservation.
   */
  reservedSeqCeiling: number;
  /** Whether the persisted reservation has been loaded this process. */
  seqReservationLoaded: boolean;
  /**
   * Seq of the first event stamped by this process, or `0` before any
   * stamp. Distinguishes a reservation skip (seqs below this value were
   * never assigned by this process, so nothing is missing from the
   * ring) from genuine ring eviction when judging replay validity.
   */
  firstStampedSeq: number;
  ring: RingEntry[];
  totalSizeBytes: number;
}

// ── State ────────────────────────────────────────────────────────────

const state: AssistantStreamState = {
  nextSeq: 1,
  reservedSeqCeiling: 0,
  seqReservationLoaded: false,
  firstStampedSeq: 0,
  ring: [],
  totalSizeBytes: 0,
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

  reserveSeqCapacity();
  event.seq = state.nextSeq++;
  if (state.firstStampedSeq === 0) state.firstStampedSeq = event.seq;

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

  // A cursor from before this process started can skip over the
  // reservation gap: seqs below `firstStampedSeq` were never assigned
  // by this process, so as long as the ring still holds everything
  // this process stamped, no replayable event is missing. (Events from
  // the previous process are unrecoverable either way — clients catch
  // up on those via the snapshot path, triggered by the seq jump.)
  const oldest = state.ring[0]?.seq ?? Infinity;
  const coversRestartGap =
    lastSeenSeq < state.firstStampedSeq && oldest === state.firstStampedSeq;
  if (lastSeenSeq < oldest - 1 && !coversRestartGap) return null;

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
 * {@link stampAndBuffer}, or the persisted reservation ceiling when this
 * process hasn't stamped yet (every seq a previous process could have
 * emitted is at or below that ceiling). `0` only on a true cold start
 * with no reservation file.
 *
 * Read synchronously right after emitting an event to learn that event's
 * `seq`: `stampAndBuffer` runs inline on the publish path (before the
 * async fanout), so no other event can interleave between the emit
 * returning and this read on the single-threaded event loop.
 */
export function getCurrentSeq(): number {
  loadSeqReservation();
  return state.nextSeq - 1;
}

/**
 * Reset all stream state. Test-only.
 */
export function _resetStreamStateForTesting(): void {
  state.nextSeq = 1;
  // Mark the reservation as loaded with no ceiling so the next stamp
  // re-reserves from 1, ignoring any reservation file a previous test
  // wrote into the (per-process temp) workspace.
  state.reservedSeqCeiling = 0;
  state.seqReservationLoaded = true;
  state.firstStampedSeq = 0;
  state.ring = [];
  state.totalSizeBytes = 0;
}

/**
 * Simulate a daemon restart: clear all in-memory state and force the
 * next stamp to reload the persisted seq reservation. Test-only.
 */
export function _simulateRestartForTesting(): void {
  state.nextSeq = 1;
  state.reservedSeqCeiling = 0;
  state.seqReservationLoaded = false;
  state.firstStampedSeq = 0;
  state.ring = [];
  state.totalSizeBytes = 0;
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

function seqReservationPath(): string {
  return join(getWorkspaceDir(), "data", "stream-seq.json");
}

/**
 * Ensure `state.nextSeq` is covered by the persisted reservation,
 * loading the reservation file on the first stamp of the process and
 * extending it by {@link SEQ_RESERVATION_BLOCK} whenever the counter
 * reaches the ceiling.
 *
 * Persistence is best-effort: if the file cannot be read or written
 * the counter falls back to in-memory-only behavior (the ceiling is
 * still advanced so the write is retried at most once per block, not
 * per event), matching the daemon's degraded-mode philosophy.
 */
/**
 * Load the persisted seq reservation once per process, advancing
 * `nextSeq` past the ceiling so this process never re-assigns (or
 * reports, via {@link getCurrentSeq}) a seq a previous process could
 * have emitted.
 */
function loadSeqReservation(): void {
  if (state.seqReservationLoaded) return;
  state.seqReservationLoaded = true;
  state.reservedSeqCeiling = readReservedCeiling();
  if (state.reservedSeqCeiling >= state.nextSeq) {
    state.nextSeq = state.reservedSeqCeiling + 1;
  }
}

function reserveSeqCapacity(): void {
  loadSeqReservation();

  if (state.nextSeq <= state.reservedSeqCeiling) return;

  const ceiling = state.nextSeq + SEQ_RESERVATION_BLOCK - 1;
  try {
    const path = seqReservationPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ reservedSeqCeiling: ceiling }));
    renameSync(tmp, path);
  } catch {
    // Degraded mode: keep stamping from memory.
  }
  state.reservedSeqCeiling = ceiling;
}

function readReservedCeiling(): number {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(seqReservationPath(), "utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "reservedSeqCeiling" in parsed
    ) {
      const ceiling = (parsed as { reservedSeqCeiling: unknown })
        .reservedSeqCeiling;
      if (
        typeof ceiling === "number" &&
        Number.isFinite(ceiling) &&
        ceiling > 0
      ) {
        return Math.floor(ceiling);
      }
    }
  } catch {
    // Missing or unreadable file: cold start from seq 1.
  }
  return 0;
}

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
