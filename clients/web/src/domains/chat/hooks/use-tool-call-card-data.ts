/** Unified data hook that powers the tool-call progress card.
 *
 *  Thin React wrapper around the pure projection in `tool-call-card-utils.ts`.
 *  Subscribes to the turn store's `liveWebActivity` map so the card data
 *  updates in lockstep with daemon-emitted metadata. */

import { useEffect, useState } from "react";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { useTurnStore } from "@/domains/chat/turn-store";

import {
  computeToolCallCardData,
  computeToolCallCardDataFromItems,
  hasRunningItem,
  type ToolCallCardData,
  type ToolCallCardItem,
} from "@/domains/chat/utils/tool-call-card-utils";

/**
 * Per-second clock that drives the card's "Working for Xs" header while a run
 * is in flight. Returns the current epoch-ms, advancing once a second only
 * while `active`; when inactive it stops the interval and holds its last
 * value (completed steps measure against their own `completedAt`, so a stale
 * `now` is harmless at rest). Returning `undefined` when inactive lets the
 * projection fall back to `completedAt`-based durations.
 */
function useNow(active: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return active ? now : undefined;
}

/**
 * React hook flavour of {@link computeToolCallCardData}. Subscribes to the
 * turn store's `liveWebActivity` map so the card data updates in lockstep
 * with daemon-emitted metadata, then delegates to the pure projection.
 */
export function useToolCallCardData(
  toolCalls: ChatMessageToolCall[],
): ToolCallCardData {
  const liveWebActivity = useTurnStore.use.liveWebActivity();
  const now = useNow(
    hasRunningItem(
      toolCalls.map((tc) => ({ kind: "toolCall", toolCall: tc })),
    ),
  );
  return computeToolCallCardData(toolCalls, liveWebActivity, now);
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
  const now = useNow(hasRunningItem(items));
  return computeToolCallCardDataFromItems(items, liveWebActivity, now);
}
