/** Unified data hook that powers the tool-call progress card.
 *
 *  Thin React wrapper around the pure projection in `tool-call-card-utils.ts`.
 *  Subscribes to the turn store's `liveWebActivity` map so the card data
 *  updates in lockstep with daemon-emitted metadata. */

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { useTurnStore } from "@/domains/chat/turn-store";

import {
  computeToolCallCardData,
  computeToolCallCardDataFromItems,
  type ToolCallCardData,
  type ToolCallCardItem,
} from "@/domains/chat/utils/tool-call-card-utils";

/**
 * React hook flavour of {@link computeToolCallCardData}. Subscribes to the
 * turn store's `liveWebActivity` map so the card data updates in lockstep
 * with daemon-emitted metadata, then delegates to the pure projection.
 */
export function useToolCallCardData(
  toolCalls: ChatMessageToolCall[],
): ToolCallCardData {
  const liveWebActivity = useTurnStore.use.liveWebActivity();
  return computeToolCallCardData(toolCalls, liveWebActivity);
}

/**
 * React hook flavour of {@link computeToolCallCardDataFromItems}. Subscribes
 * to the turn store's `liveWebActivity` map and delegates to the ordered-items
 * pure projection, letting callers interleave thinking between tool steps.
 */
export function useToolCallCardDataFromItems(
  items: ToolCallCardItem[],
): ToolCallCardData {
  const liveWebActivity = useTurnStore.use.liveWebActivity();
  return computeToolCallCardDataFromItems(items, liveWebActivity);
}
