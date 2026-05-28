/**
 * Durable per-conversation streaming-event log.
 *
 * Every streaming event emitted during an assistant turn is appended to the
 * `conversation_events` table alongside the live SSE publish. The table
 * backs the SSE `Last-Event-Id` reconnect protocol: when a client drops a
 * stream mid-turn, it re-subscribes with the last `seq` it observed and
 * the daemon replays every persisted row with `seq > last_event_id`
 * before fanning live events into the new connection.
 *
 * Storage is intentionally append-only; rows are pruned by
 * {@link trimEventsOlderThan} (called from the daemon's startup cleanup
 * hook) rather than per-conversation truncation, so a reconnecting client
 * can always resume from the last `seq` it observed even when the
 * conversation has since been evicted from in-memory state.
 *
 * The neutral `AssistantEvent` envelope is what subscribers receive on the
 * wire, so we persist the full envelope JSON to keep replay verbatim. The
 * `event_type`, `message_id`, and `block_index` columns are denormalized
 * from the payload to support targeted queries (debugging, future
 * per-message replay) without re-parsing every row.
 */

import { rawAll, rawRun } from "../memory/raw-query.js";
import { getLogger } from "../util/logger.js";
import type { ServerMessage } from "./message-protocol.js";

const log = getLogger("event-log");

/**
 * Event types persisted to the durable log. Restricting writes to the
 * streaming-architecture event set keeps the log small and avoids racing
 * with bespoke broadcasts (sync invalidations, host-proxy traffic) that
 * are not part of the replay protocol. The set mirrors the events PR 1
 * stamped with `seq` — `message_complete` and `generation_handoff` are
 * intentionally absent because they still emit without `seq` from the
 * orchestrator and replay would deliver them out of order relative to
 * the addressable events around them.
 */
const LOGGED_EVENT_TYPES = new Set<string>([
  "message_open",
  "block_open",
  "block_close",
  "message_close",
  "assistant_text_delta",
  "tool_use_start",
  "tool_input_delta",
  "tool_result",
]);

/** Row shape returned by {@link readEventsAfter}. */
export interface ConversationEventRow {
  conversationId: string;
  seq: number;
  eventType: string;
  messageId: string | null;
  blockIndex: number | null;
  payloadJson: string;
  createdAt: number;
}

/** True when the event type is one we persist to the durable log. */
export function isLoggableEvent(eventType: string): boolean {
  return LOGGED_EVENT_TYPES.has(eventType);
}

interface EventLike {
  type: string;
  seq?: number;
  messageId?: string;
  blockIndex?: number;
}

/**
 * Append a streaming event to the durable log.
 *
 * No-op when the event type is not in {@link LOGGED_EVENT_TYPES} or when
 * the event does not carry a `seq` field (only post-PR-1 streaming events
 * are addressable, so writing a row without `seq` would create a gap that
 * the replay path cannot honor).
 *
 * Errors from the DB write are caught and logged — the live SSE publish
 * already succeeded, so a write failure here only degrades replay, never
 * the in-flight turn. Mirrors the non-fatal stance used across the
 * agent-loop persistence calls.
 */
export function appendEvent(
  conversationId: string,
  message: ServerMessage,
): void {
  if (!isLoggableEvent(message.type)) return;
  const event = message as EventLike;
  if (typeof event.seq !== "number") return;
  try {
    rawRun(
      `INSERT INTO conversation_events
       (conversation_id, seq, event_type, message_id, block_index, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, seq) DO NOTHING`,
      conversationId,
      event.seq,
      message.type,
      typeof event.messageId === "string" ? event.messageId : null,
      typeof event.blockIndex === "number" ? event.blockIndex : null,
      JSON.stringify(message),
      Date.now(),
    );
  } catch (err) {
    log.warn(
      { err, conversationId, eventType: message.type, seq: event.seq },
      "Failed to append conversation event (non-fatal)",
    );
  }
}

/**
 * Return every event for `conversationId` with `seq > afterSeq`, in seq
 * order. Used by the SSE handshake to replay events the client missed
 * before subscribing to live events.
 */
export function readEventsAfter(
  conversationId: string,
  afterSeq: number,
): ConversationEventRow[] {
  return rawAll<{
    conversation_id: string;
    seq: number;
    event_type: string;
    message_id: string | null;
    block_index: number | null;
    payload_json: string;
    created_at: number;
  }>(
    `SELECT conversation_id, seq, event_type, message_id, block_index,
            payload_json, created_at
     FROM conversation_events
     WHERE conversation_id = ? AND seq > ?
     ORDER BY seq ASC`,
    conversationId,
    afterSeq,
  ).map((row) => ({
    conversationId: row.conversation_id,
    seq: row.seq,
    eventType: row.event_type,
    messageId: row.message_id,
    blockIndex: row.block_index,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  }));
}

/**
 * Read the highest persisted `seq` for `conversationId`. Used by
 * {@link nextSeq} to reseed the in-memory counter when a conversation
 * re-enters memory after eviction, so a fresh `nextSeq()` cannot collide
 * with rows the previous incarnation wrote.
 *
 * Returns `0` when the DB is unavailable or the query fails — the worst
 * case is a sequence-collision risk for evicted conversations under DB
 * stress, which is bounded by the 7-day retention window. The fallback
 * also keeps unit tests that exercise streaming handlers without a real
 * DB working without per-test mocking.
 */
export function maxSeqForConversation(conversationId: string): number {
  try {
    const row = rawAll<{ max_seq: number | null }>(
      `SELECT MAX(seq) AS max_seq FROM conversation_events WHERE conversation_id = ?`,
      conversationId,
    )[0];
    return row?.max_seq ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Drop event rows older than `cutoffMs` (epoch ms). Returns the number of
 * rows deleted. The default retention window is 7 days — long enough to
 * absorb realistic reconnect gaps (network drops, app backgrounding,
 * device sleep) while keeping the table bounded.
 */
export function trimEventsOlderThan(cutoffMs: number): number {
  try {
    return rawRun(
      `DELETE FROM conversation_events WHERE created_at < ?`,
      cutoffMs,
    );
  } catch (err) {
    log.warn(
      { err, cutoffMs },
      "Failed to trim conversation_events (non-fatal)",
    );
    return 0;
  }
}

/** Default retention window for the durable event log. */
export const EVENT_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Run a single retention sweep using {@link EVENT_LOG_RETENTION_MS}.
 *
 * Called once at daemon startup. Keeping the cleanup minimal (single
 * sweep at boot rather than a periodic cron) is intentional — the table
 * is small for active installs and the next boot will catch up any
 * accumulation between restarts.
 */
export function runEventLogCleanup(): number {
  const cutoff = Date.now() - EVENT_LOG_RETENTION_MS;
  const deleted = trimEventsOlderThan(cutoff);
  if (deleted > 0) {
    log.info({ deleted, cutoff }, "Trimmed conversation_events");
  }
  return deleted;
}
