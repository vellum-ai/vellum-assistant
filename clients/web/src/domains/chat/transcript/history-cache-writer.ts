/**
 * Write helpers for the conversation-history infinite query — the single
 * source of truth for every server-known message, including the in-flight
 * streaming turn.
 *
 * Before this module the streaming apply path wrote a *second* copy of the
 * in-flight turn into a Zustand `liveTurn` array, which a read-time overlay
 * then merged back over the history cache. That duality is the root of the
 * "vanishing prefix" class of bugs: on re-attach mid-stream the history
 * snapshot carried the persisted prefix (≤ persisted `seq`) while the
 * replayed deltas (> `seq`) landed on a *fresh* `liveTurn` row, and the
 * overlay — keying on the live row — dropped the prefix.
 *
 * Routing deltas straight into the cache collapses the two copies into one.
 * The history snapshot seeds the row; deltas append onto that same row.
 *
 * Two write shapes, deliberately distinct:
 *
 * - {@link applyToInFlightTurn} targets ONLY the latest page (`pages[0]`),
 *   where the daemon always reserves the in-flight turn. The streaming hot
 *   path (text/thinking deltas, tool calls, idle/complete finalize) runs
 *   per-token, so it must stay O(latest page) rather than O(all loaded
 *   pages), and its tail-fallback updaters (`appendTextDelta`) would
 *   mis-fire on an older page whose tail happens to be an assistant row.
 *
 * - {@link patchHistoryPages} runs a no-op-safe updater across EVERY loaded
 *   page, for cleanup that may target a row in any page (surface /
 *   confirmation retirement after a send). These updaters return `prev`
 *   unchanged when they match nothing, so fanning them out is safe.
 */

import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import type { DisplayMessage } from "@/domains/chat/types/types";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";

/** The shape `useInfiniteQuery` stores for the conversation-history key. */
export type HistoryCache = InfiniteData<PaginatedHistoryResult>;

/** Pure transform over a page's messages (oldest-first within the page). */
export type MessagesUpdater = (prev: DisplayMessage[]) => DisplayMessage[];

/**
 * Apply `updater` to the in-flight turn — the messages of the latest page
 * (`pages[0]`). No-op (returns the cache untouched) when the updater makes
 * no change, so a delta that doesn't move the row won't churn query
 * subscribers.
 *
 * When the cache has no data yet — the stream beat the initial history
 * fetch, or this is the very first turn of a brand-new conversation — a
 * single synthetic latest page is seeded so the streaming row still renders
 * immediately. The subsequent real fetch reconciles it (see the seq-gated
 * merge in `use-history-pagination`), so the synthetic `hasMore: false`
 * never strands pagination.
 */
export function applyToInFlightTurn(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  updater: MessagesUpdater,
): void {
  queryClient.setQueryData<HistoryCache>(queryKey, (data) => {
    if (!data || data.pages.length === 0) {
      const seeded = updater([]);
      if (seeded.length === 0) return data;
      return {
        pageParams: [null],
        pages: [
          {
            messages: seeded,
            hasMore: false,
            oldestTimestamp: null,
            oldestMessageId: null,
          },
        ],
      };
    }

    const [latest, ...rest] = data.pages;
    const nextMessages = updater(latest!.messages);
    // Referential no-op guard: the streaming updaters return the same array
    // when nothing changed, so skip the cache write entirely.
    if (nextMessages === latest!.messages) return data;
    return {
      ...data,
      pages: [{ ...latest!, messages: nextMessages }, ...rest],
    };
  });
}

/**
 * Apply a no-op-safe `updater` to every loaded page. Use for cleanup that
 * may land on a row in any page (e.g. retiring a resolved surface or
 * confirmation placeholder after the user sends the next message). The
 * updater MUST return its input array unchanged when it matches nothing —
 * otherwise it would rewrite untouched pages and thrash their subscribers.
 *
 * No-op when no page actually changed.
 */
export function patchHistoryPages(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  updater: MessagesUpdater,
): void {
  queryClient.setQueryData<HistoryCache>(queryKey, (data) => {
    if (!data || data.pages.length === 0) return data;
    let changed = false;
    const pages = data.pages.map((page) => {
      const next = updater(page.messages);
      if (next === page.messages) return page;
      changed = true;
      return { ...page, messages: next };
    });
    return changed ? { ...data, pages } : data;
  });
}
