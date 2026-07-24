/**
 * Assistant Events -- generic SSE envelope, framing helpers, and the
 * daemon-side specialization.
 *
 * The generic `BaseAssistantEvent<TMessage>` envelope and its framing
 * helpers carry no daemon imports. The daemon-side `AssistantEvent` type and
 * `buildAssistantEvent` builder pin the payload to the canonical
 * `AssistantEvent` message union (`z.infer<AssistantEventSchema>`), so callers
 * get full discriminated-union narrowing. The concrete envelope shape is the
 * canonical `AssistantEventEnvelope` from `../api`.
 */

import { randomUUID } from "node:crypto";

import type {
  AssistantEvent as AssistantEventMessage,
  AssistantEventEnvelope,
} from "../api/index.js";

// -- Generic base --------------------------------------------------------------

/**
 * A single assistant event wrapping an outbound message payload.
 *
 * Generic over the payload type. The `TMessage` default of `unknown` keeps
 * the envelope nameable without a type argument when the caller does not
 * care about message narrowing.
 */
interface BaseAssistantEvent<TMessage = unknown> {
  /** Globally unique event identifier (UUID). */
  id: string;
  /** Resolved conversation id when available. */
  conversationId?: string;
  /**
   * Monotonic per-conversation sequence number. Assigned by the daemon at
   * publish time for conversation-scoped events; absent for unscoped
   * broadcasts. Clients track the highest observed `seq` per conversation
   * and pass it back on reconnect to request replay of missed events.
   */
  seq?: number;
  /** ISO-8601 timestamp of when the event was emitted. */
  emittedAt: string;
  /** Outbound message payload. */
  message: TMessage;
}

/**
 * Construct a `BaseAssistantEvent` envelope around a message payload.
 *
 * @param message         The outbound message payload.
 * @param conversationId  Optional conversation id -- pass when known.
 */
function baseBuildAssistantEvent<TMessage>(
  message: TMessage,
  conversationId?: string,
): BaseAssistantEvent<TMessage> {
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
 *
 * The SSE `id:` line is the per-event UUID and is intentionally decoupled
 * from any replay cursor. Replay-aware consumers read `seq` from the JSON
 * payload of the envelope itself.
 */
export function formatSseFrame(event: BaseAssistantEvent): string {
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

// -- Daemon-side specialization ------------------------------------------------

// Re-export the canonical envelope so daemon callers import it alongside the
// builder below.
export type { AssistantEventEnvelope };

/**
 * Build a daemon event envelope (`AssistantEventEnvelope`) around an
 * `AssistantEvent` message payload.
 */
export function buildAssistantEvent(
  message: AssistantEventMessage,
  conversationId?: string,
): AssistantEventEnvelope {
  return baseBuildAssistantEvent<AssistantEventMessage>(
    message,
    conversationId,
  );
}
