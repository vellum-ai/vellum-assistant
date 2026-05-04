/**
 * Assistant Events -- shared types and SSE framing helpers.
 *
 * This module is intentionally free of imports from `assistant/` or any
 * other repo-local module so it can be consumed by both the daemon and
 * isolated skill processes without circular references.
 *
 * The `AssistantEvent` interface is generic over the `message` payload so
 * the neutral package does not need to know about the daemon-side
 * `ServerMessage` discriminated union. Consumers that want narrower
 * typing can re-export a specialized alias, e.g.:
 *
 *   type AssistantEvent = BaseAssistantEvent<ServerMessage>;
 */

import { randomUUID } from "node:crypto";

// -- Types ---------------------------------------------------------------------

/**
 * A single assistant event wrapping an outbound message payload.
 *
 * Generic over the payload type so the neutral package has zero dependency
 * on daemon-side message schemas. The `TMessage` default of `unknown`
 * keeps the package importable without a type argument when the caller
 * does not care about message narrowing.
 */
export interface AssistantEvent<TMessage = unknown> {
  /** Globally unique event identifier (UUID). */
  id: string;
  /** Resolved conversation id when available. */
  conversationId?: string;
  /** ISO-8601 timestamp of when the event was emitted. */
  emittedAt: string;
  /** Outbound message payload. */
  message: TMessage;
}

// -- Factory -------------------------------------------------------------------

/**
 * Construct an `AssistantEvent` envelope around a message payload.
 *
 * @param message         The outbound message payload.
 * @param conversationId  Optional conversation id -- pass when known.
 */
export function buildAssistantEvent<TMessage>(
  message: TMessage,
  conversationId?: string,
): AssistantEvent<TMessage> {
  return {
    id: randomUUID(),
    conversationId,
    emittedAt: new Date().toISOString(),
    message,
  };
}

// -- SSE framing ---------------------------------------------------------------

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

/**
 * Format a keep-alive as both an SSE comment (for proxy keepalive) and a
 * data-bearing event (so fetch-based SSE clients that cannot observe comment
 * lines can still detect heartbeats for disconnect watchdogs).
 */
export function formatSseHeartbeatWithData(): string {
  return `${formatSseHeartbeat()}event: assistant_event\ndata: ${JSON.stringify({ type: "heartbeat" })}\n\n`;
}
