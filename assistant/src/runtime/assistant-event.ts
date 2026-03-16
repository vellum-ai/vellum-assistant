/**
 * Assistant Events — shared types and SSE framing helpers.
 *
 * Fully isolated from daemon/runtime orchestration logic.
 * Import this module from any layer that needs to produce or consume
 * assistant events without creating circular dependencies.
 */

import { randomUUID } from "node:crypto";

import type { ServerMessage } from "../daemon/message-protocol.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single assistant event wrapping a ServerMessage payload.
 * The `message` field preserves the original form so that
 * delta semantics (text deltas, tool input deltas, etc.) are preserved.
 */
export interface AssistantEvent {
  /** Globally unique event identifier (UUID). */
  id: string;
  /** The assistant this event belongs to. */
  assistantId: string;
  /** Resolved conversation id when available. */
  conversationId?: string;
  /** ISO-8601 timestamp of when the event was emitted. */
  emittedAt: string;
  /** Outbound server message payload. */
  message: ServerMessage;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Construct an `AssistantEvent` envelope around a `ServerMessage`.
 *
 * @param assistantId  The logical assistant identifier (e.g. from the daemon or HTTP route).
 * @param message      The outbound server message payload.
 * @param conversationId    Optional conversation id — pass when known.
 */
export function buildAssistantEvent(
  assistantId: string,
  message: ServerMessage,
  conversationId?: string,
): AssistantEvent {
  return {
    id: randomUUID(),
    assistantId,
    conversationId,
    emittedAt: new Date().toISOString(),
    message,
  };
}

// ── SSE framing ───────────────────────────────────────────────────────────────

/**
 * Format an AssistantEvent as a Server-Sent Events frame.
 *
 * The SSE spec (https://html.spec.whatwg.org/multipage/server-sent-events.html)
 * requires each field on its own line with a trailing blank line.
 *
 * ```
 * event: assistant_event\n
 * id: <event.id>\n
 * data: <JSON>\n
 * \n
 * ```
 */
export function formatSseFrame(event: AssistantEvent): string {
  const sanitizedId = event.id.replace(/[\n\r]/g, "");
  const data = JSON.stringify(event);
  return `event: assistant_event\nid: ${sanitizedId}\ndata: ${data}\n\n`;
}

/**
 * Format a keep-alive SSE comment.
 * Clients should ignore comment lines (`:`) per the SSE spec.
 */
export function formatSseHeartbeat(): string {
  return ": heartbeat\n\n";
}
