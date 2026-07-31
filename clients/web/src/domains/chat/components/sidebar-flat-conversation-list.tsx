/**
 * The "All" view's flat conversation list: every conversation that is neither
 * pinned nor in a custom group, newest first, with no header and no channel
 * bucketing.
 *
 * Virtualized, because this list has no ceiling: an assistant accumulates
 * conversations indefinitely and they all arrive in one query, so mounting a
 * row per conversation would grow the DOM without bound. Windowing keeps that
 * cost proportional to the viewport instead, and it is what "keeps scrolling"
 * means here - there is no page to fetch, only rows to render.
 *
 * `scrollParent` is the sidebar's own scrollport. Rooting on it (rather than
 * letting the list open a scroller of its own) is what keeps the rail to one
 * scrollbar, with Pinned and the custom groups scrolling as part of the same
 * surface.
 *
 * Rows render through {@link ConversationRow} directly - the same row every
 * section uses, minus the `SideMenu.SubList` wrapper, whose `ul` semantics
 * virtuoso's own item elements would break.
 */

import { VirtualList } from "@vellumai/design-library/components/virtual-list";

import { ConversationRow } from "@/domains/chat/components/conversation-row";
import type { Conversation } from "@/types/conversation-types";

export interface SidebarFlatConversationListProps {
  conversations: Conversation[];
  /**
   * The ancestor that scrolls this list. Null until the sidebar body mounts,
   * which is the one render where the list stays unmounted rather than
   * briefly opening a nested scroller.
   */
  scrollParent: HTMLElement | null;
}

export function SidebarFlatConversationList({
  conversations,
  scrollParent,
}: SidebarFlatConversationListProps) {
  if (!scrollParent) {
    return null;
  }

  return (
    <VirtualList
      items={conversations}
      customScrollParent={scrollParent}
      computeItemKey={(_, conversation) => conversation.conversationId}
      itemContent={(_, conversation) => (
        <ConversationRow conversation={conversation} />
      )}
      /* The primitive paints `--surface-base` for a list that owns its
         surface; here the sidebar has already painted `--surface-overlay`
         underneath. */
      className="bg-transparent"
    />
  );
}
