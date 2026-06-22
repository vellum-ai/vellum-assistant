/**
 * SSE event parsing for the assistant chat stream.
 *
 * Exports `parseAssistantEvent`, which takes a raw SSE payload and
 * returns a typed `AssistantEventEnvelope`. The primary path validates
 * the full envelope (metadata + inner message) against
 * `AssistantEventEnvelopeSchema` from `@vellumai/assistant-api`.
 * Payloads that don't match (unknown event types, legacy flat shapes)
 * are wrapped in an envelope with an `UnknownEvent` message so callers
 * can safely ignore them without crashing.
 */

import type { AssistantEvent } from "@/types/event-types";
import {
  AssistantEventEnvelopeSchema,
  AssistantEventSchema,
  type AssistantEventEnvelope,
} from "@vellumai/assistant-api";
import { unknownEvent } from "@/lib/streaming/parse-helpers";
import { unwrapMessageEnvelope } from "@/lib/streaming/sse-payload";

/**
 * Parse a raw SSE payload into a typed `AssistantEventEnvelope`.
 *
 * Primary path: `AssistantEventEnvelopeSchema.safeParse` validates the
 * full envelope in one shot. Fallback: extract the inner event (from
 * `data.message` if envelope-shaped, or `data` itself if flat), try the
 * inner schema, and wrap the result in a synthetic envelope.
 */
export function parseAssistantEvent(
  data: Record<string, unknown>,
): AssistantEventEnvelope {
  const envelopeResult = AssistantEventEnvelopeSchema.safeParse(data);
  if (envelopeResult.success) {
    return envelopeResult.data;
  }

  // Determine the inner payload: envelope-wrapped or flat shape.
  const unwrapped = unwrapMessageEnvelope(data);
  const inner =
    unwrapped !== data && typeof (unwrapped as Record<string, unknown>).type === "string"
      ? unwrapped
      : data;

  const innerResult = AssistantEventSchema.safeParse(inner);
  const event: AssistantEvent = innerResult.success
    ? (innerResult.data as AssistantEvent)
    : unknownEvent(typeof inner.type === "string" ? inner.type : "", inner);

  return {
    id: typeof data.id === "string" ? data.id : "",
    conversationId:
      typeof data.conversationId === "string"
        ? data.conversationId
        : undefined,
    seq: typeof data.seq === "number" ? data.seq : undefined,
    emittedAt: typeof data.emittedAt === "string" ? data.emittedAt : "",
    message: event,
  } as AssistantEventEnvelope;
}
