/**
 * Flyout body shown when a collapsed-rail group icon is opened.
 *
 * Rows here are deliberately lighter than the full sidebar: no right-click
 * context menu, no hover marquee, no drag — but they keep the trailing
 * actions menu. Selecting a row closes the flyout popover and then runs the
 * normal select (which also closes the overlay sidebar on mobile).
 *
 * The list is bounded: a section can hold an unbounded number of
 * conversations (Chats, or the All view's whole list), and a popover that
 * mounts every one of them would grow past the screen and jank on open. Past
 * {@link VIRTUALIZE_THRESHOLD} rows it windows instead, which is the case
 * `VirtualList` is built for here: unlike the sidebar body, the flyout owns
 * its scroll region, so the list can have the bounded height virtuoso's own
 * scroller needs.
 */

import { VirtualList } from "@vellumai/design-library/components/virtual-list";

import { useConversationListContext } from "@/domains/chat/components/conversation-list-context";
import { ConversationRow } from "@/domains/chat/components/conversation-row";
import type { Conversation } from "@/types/conversation-types";

/**
 * Row count past which the flyout windows. Below it the rows mount directly,
 * which is the common case (a custom group, a quiet channel) and skips
 * virtuoso's measuring pass entirely.
 */
const VIRTUALIZE_THRESHOLD = 30;

export interface CollapsedGroupFlyoutProps {
  title: string;
  conversations: Conversation[];
  /** Close the rail flyout popover (in addition to selecting). */
  onClosePopover?: () => void;
}

export function CollapsedGroupFlyout({
  title,
  conversations,
  onClosePopover,
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
        {conversations.length > VIRTUALIZE_THRESHOLD ? (
          /* Virtuoso's scroller sizes to 100%, so the wrapper is what bounds
             it. The plain branch below caps at the same height. */
          <div className="h-96">
            <VirtualList
              items={conversations}
              computeItemKey={(_, conversation) => conversation.conversationId}
              itemContent={(_, conversation) => renderRow(conversation)}
              className="h-full bg-transparent"
            />
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {conversations.map(renderRow)}
          </div>
        )}
      </div>
    </div>
  );
}
