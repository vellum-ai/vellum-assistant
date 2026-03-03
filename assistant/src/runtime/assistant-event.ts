/**
 * Assistant Events — shared types and SSE framing helpers.
 *
 * Fully isolated from daemon/runtime orchestration logic.
 * Import this module from any layer that needs to produce or consume
 * assistant events without creating circular dependencies.
 */

import { randomUUID } from 'node:crypto';

import type { ServerMessage } from '../daemon/ipc-protocol.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single assistant event wrapping an IPC ServerMessage payload.
 * The `message` field is intentionally unchanged from the IPC form so that
 * delta semantics (text deltas, tool input deltas, etc.) are preserved.
 */
export interface AssistantEvent {
  /** Globally unique event identifier (UUID). */
  id: string;
  /** The assistant this event belongs to. */
  assistantId: string;
  /** Resolved conversation/session id when available. */
  sessionId?: string;
  /** ISO-8601 timestamp of when the event was emitted. */
  emittedAt: string;
  /** Unchanged IPC outbound message payload. */
  message: ServerMessage;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Construct an `AssistantEvent` envelope around a `ServerMessage`.
 *
 * @param assistantId  The logical assistant identifier (e.g. from the daemon or HTTP route).
 * @param message      The unchanged IPC outbound message payload.
 * @param sessionId    Optional conversation/session id — pass when known.
 */
export function buildAssistantEvent(
  assistantId: string,
  message: ServerMessage,
  sessionId?: string,
): AssistantEvent {
  return {
    id: randomUUID(),
    assistantId,
    sessionId,
    emittedAt: new Date().toISOString(),
    message,
  };
}

// ── NDJSON framing ────────────────────────────────────────────────────────────

/**
 * Format an AssistantEvent as an NDJSON line.
 *
 * Each event is serialized as a single JSON object on its own line,
 * containing the SSE-equivalent fields (`event`, `id`, `data`).
 *
 * ```
 * {"event":"assistant_event","id":"<event.id>","data":{...}}\n
 * ```
 */
export function formatSseFrame(event: AssistantEvent): string {
  const line = JSON.stringify({
    event: 'assistant_event',
    id: event.id,
    data: event,
  });
  return line + '\n';
}

/**
 * Format a keep-alive heartbeat as an NDJSON line.
 *
 * ```
 * {"event":"heartbeat"}\n
 * ```
 */
export function formatSseHeartbeat(): string {
  return JSON.stringify({ event: 'heartbeat' }) + '\n';
}
