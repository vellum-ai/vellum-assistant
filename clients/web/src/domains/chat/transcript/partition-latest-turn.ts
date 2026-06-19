// Split a flat `TranscriptItem[]` into stable history + the
// currently-in-progress turn. The scroll coordinator uses this to pin
// the viewport to the anchor user message while the response renders,
// and to allow the history half to be virtualized independently of the
// actively-streaming response half.

import type { LatestTurnPartition, MessageItem, TranscriptItem } from "@/domains/chat/transcript/types";

/**
 * Walk `items` from the end to find the most recent `MessageItem` whose
 * `message.role === "user"`. Everything before that index is
 * `historyItems`, the matched item is `anchorMessage`, everything after
 * it is `responseItems`.
 *
 * If no user message exists (e.g. transcript consists purely of trailers
 * or assistant-only history), `anchorMessage` is `null`, `historyItems`
 * is the full input, and `responseItems` is empty.
 */
export function partitionLatestTurn(
  items: TranscriptItem[],
): LatestTurnPartition {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && item.kind === "message" && item.message.role === "user") {
      const anchor: MessageItem = item;
      return {
        historyItems: items.slice(0, i),
        anchorMessage: anchor,
        responseItems: items.slice(i + 1),
      };
    }
  }

  return {
    historyItems: items.slice(),
    anchorMessage: null,
    responseItems: [],
  };
}
