/**
 * Flyout body shown when a collapsed-rail group icon is opened.
 *
 * Rows here are deliberately lighter than the full sidebar: no right-click
 * context menu, no hover marquee, no drag — but they keep the trailing
 * actions menu. Selecting a row closes the flyout popover and then runs the
 * normal select (which also closes the overlay sidebar on mobile).
 */

import { useConversationListContext } from "@/domains/chat/components/conversation-list-context";
import { ConversationRow } from "@/domains/chat/components/conversation-row";
import type { Conversation } from "@/types/conversation-types";

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
  return (
    <div className="pb-1">
      <div className="flex items-center justify-between px-4 py-1">
        <span className="text-body-small-default text-[var(--content-tertiary)]">
          {title}
        </span>
      </div>
      <div className="px-2">
        {conversations.map((conversation) => (
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
        ))}
      </div>
    </div>
  );
}
