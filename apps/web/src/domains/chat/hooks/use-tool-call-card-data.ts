/** Unified data hook that powers the tool-call progress card.
 *
 *  Thin React wrapper around the pure projection in `tool-call-card-utils.ts`.
 *  Subscribes to the turn store's `liveWebActivity` map so the card data
 *  updates in lockstep with daemon-emitted metadata. */

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { useTurnStore } from "@/domains/chat/turn-store";

import {
  computeToolCallCardData,
  type ToolCallCardData,
} from "@/domains/chat/hooks/tool-call-card-utils";

/**
 * React hook flavour of {@link computeToolCallCardData}. Subscribes to the
 * turn store's `liveWebActivity` map so the card data updates in lockstep
 * with daemon-emitted metadata, then delegates to the pure projection.
 */
export function useToolCallCardData(
  toolCalls: ChatMessageToolCall[],
  leadingThinkingText: string | null,
): ToolCallCardData {
  const liveWebActivity = useTurnStore.use.liveWebActivity();
  return computeToolCallCardData(toolCalls, liveWebActivity, leadingThinkingText);
}
