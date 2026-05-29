/**
 * Shared helpers for legacy event sub-parsers.
 */

import type { AssistantEvent } from "@/types/event-types";

/**
 * Build the `unknown` fallback event, preserving the raw type, the
 * original payload, and any conversation scope so downstream filters
 * (e.g. per-conversation SSE subscribers) still route correctly.
 */
export function unknownEvent(
  rawType: string,
  data: Record<string, unknown>,
): AssistantEvent {
  return {
    type: "unknown",
    rawType,
    data,
    conversationId:
      typeof data.conversationId === "string" ? data.conversationId : undefined,
  };
}
