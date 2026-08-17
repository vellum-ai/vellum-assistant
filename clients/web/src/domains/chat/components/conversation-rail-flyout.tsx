/**
 * Flyout body shown when a collapsed-rail group icon is opened.
 *
 * Rows here are deliberately lighter than the full sidebar: no right-click
 * context menu, no hover marquee, no drag — but they keep the trailing
 * actions menu. Selecting a row closes the flyout popover and then runs the
 * normal select (which also closes the overlay sidebar on mobile).
 *
 * A section can hold an unbounded number of conversations (Chats, or the All
 * view's whole list), and a popover that mounts every one of them would jank
 * on open. Past {@link CONVERSATION_LIST_VIRTUALIZE_THRESHOLD} rows the list
 * windows instead, against the popover's own scrollport rather than a box of
 * its own, so the flyout keeps a single scrollbar and its full height.
 */

import { VirtualList } from "@vellumai/design-library/components/virtual-list";

import { CONVERSATION_LIST_VIRTUALIZE_THRESHOLD } from "@/domains/chat/components/conversation-nav-section";
import { useConversationListContext } from "@/domains/chat/components/conversation-list-context";
import { ConversationRow } from "@/domains/chat/components/conversation-row";
import { LoadMoreSentinel } from "@/domains/chat/components/load-more-sentinel";
import type { Conversation } from "@/types/conversation-types";

export interface CollapsedGroupFlyoutProps {
  title: string;
  conversations: Conversation[];
  /** Close the rail flyout popover (in addition to selecting). */
  onClosePopover?: () => void;
  /**
   * The popover's own scrollport. A long list windows against it, so the
   * flyout adds no second scroll region of its own.
   */
  scrollParent?: HTMLElement | null;
  /**
   * Load-more trigger for a windowed section (LUM-2444); the flyout shows
   * the same window as the expanded card, so it pages the same way.
   */
  onEndReached?: () => void;
}

export function CollapsedGroupFlyout({
  title,
  conversations,
  onClosePopover,
  scrollParent,
  onEndReached,
}: CollapsedGroupFlyoutProps) {
  const ctx = useConversationListContext();

  const renderRow = (conversation: Conversation) => (
    <ConversationRow
      key={conversation.conversationId}
      conversation={conversation}
      withContextMenu={false}
      marquee={false}
      onSelect={(id) => {
        onClosePopover?.();
        ctx.onSelect(id);
      }}
    />
  );

  return (
    <div className="pb-1">
      <div className="flex items-center justify-between px-4 py-1">
        <span className="text-body-small-default text-[var(--content-tertiary)]">
          {title}
        </span>
      </div>
      <div className="px-2">
        {conversations.length > CONVERSATION_LIST_VIRTUALIZE_THRESHOLD &&
        scrollParent ? (
          <VirtualList
            items={conversations}
            customScrollParent={scrollParent}
            computeItemKey={(_, conversation) => conversation.conversationId}
            itemContent={(_, conversation) => renderRow(conversation)}
            endReached={onEndReached}
            className="bg-transparent"
          />
        ) : (
          <>
            {conversations.map(renderRow)}
            {/* Only under a measured scrollport. Unmeasured, nothing clips
                the sentinel, so it stays visible after every append and
                would page the entire section in on open. */}
            {onEndReached && scrollParent ? (
              <LoadMoreSentinel onVisible={onEndReached} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
