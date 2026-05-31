/**
 * SSE event parsing for the assistant chat stream.
 *
 * Exports `parseAssistantEvent`, which takes a raw SSE payload and
 * returns a typed `AssistantEvent`. The parser unwraps the
 * envelope/flat shape and validates the inner message against the
 * canonical `AssistantEventSchema` from `@vellumai/assistant-api`,
 * which is the source of truth for every wire event. Anything the
 * union doesn't recognise becomes an `UnknownEvent` so callers can
 * safely ignore it without crashing.
 */

import type { AssistantEvent } from "@/types/event-types";
import { AssistantEventSchema } from "@vellumai/assistant-api";
import { unknownEvent } from "@/lib/streaming/parse-helpers";

/**
 * Unwrap envelope-shape payloads `{ message: { type, ...fields }, conversationId }`
 * into the inner event. Flat-shape payloads `{ type, ...fields }` pass
 * through unchanged.
 *
 * Pure unwrap: the envelope-level `conversationId` (SSE routing key)
 * is NOT merged onto the inner message. Canonical schemas that don't
 * declare `conversationId` stay strict; the routing key is only folded
 * back in via `mergeEnvelopeConversationId` when building the
 * `UnknownEvent` fallback.
 */
function unwrapEnvelope(data: Record<string, unknown>): {
  inner: Record<string, unknown>;
  envelopeConversationId: string | undefined;
} {
  const message = data.message;
  if (
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    typeof (message as Record<string, unknown>).type === "string"
  ) {
    return {
      inner: message as Record<string, unknown>,
      envelopeConversationId:
        typeof data.conversationId === "string"
          ? data.conversationId
          : undefined,
    };
  }
  return { inner: data, envelopeConversationId: undefined };
}

/**
 * Merge the envelope-level `conversationId` onto the inner data when
 * the inner doesn't already declare one. Applied only when building the
 * `UnknownEvent` fallback, so per-conversation SSE subscribers can
 * still route an unrecognised payload by its envelope scope. Canonical
 * events never go through this — they declare the fields they require,
 * so the envelope routing key never leaks onto a parsed event.
 */
function mergeEnvelopeConversationId(
  inner: Record<string, unknown>,
  envelopeConversationId: string | undefined,
): Record<string, unknown> {
  if (envelopeConversationId && typeof inner.conversationId !== "string") {
    return { ...inner, conversationId: envelopeConversationId };
  }
  return inner;
}

/**
 * Parse a raw SSE payload into a typed `AssistantEvent`. Owns envelope
 * unwrap and canonical-schema dispatch. Tolerant of unknown event
 * types — returns an `UnknownEvent` for anything unrecognised so
 * callers can safely ignore it without crashing.
 */
export function parseAssistantEvent(
  data: Record<string, unknown>,
): AssistantEvent {
  const { inner, envelopeConversationId } = unwrapEnvelope(data);

  // The discriminated union in `@vellumai/assistant-api` is the source
  // of truth for every wire event. The schema sees the pure inner
  // message (no envelope merge): every schema declares the fields it
  // requires (including `conversationId` for conversation-scoped
  // events), so the envelope-level routing key never needs grafting on.
  const schemaResult = AssistantEventSchema.safeParse(inner);
  if (schemaResult.success) return schemaResult.data as AssistantEvent;

  // Unrecognised payload. Stamp the envelope conversationId onto the
  // fallback so per-conversation subscribers can still route it.
  const merged = mergeEnvelopeConversationId(inner, envelopeConversationId);
  const rawType = typeof merged.type === "string" ? merged.type : "";
  return unknownEvent(rawType, merged);
}
