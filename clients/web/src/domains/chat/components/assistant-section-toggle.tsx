import { MessageSquare } from "lucide-react";

import { AssistantSectionEmptyState } from "@/domains/chat/components/assistant-section-empty-state";
import {
  CollapsedFlyout,
  getGroupIndicatorState,
  GroupIndicatorDot,
  type GroupIndicatorState,
} from "@/domains/chat/components/collapsed-group-icon";
import { CollapsedGroupFlyout } from "@/domains/chat/components/conversation-rail-flyout";
import { SIDEBAR_ASSISTANT_DISC_SIZE } from "@/components/sidebar-nav-geometry";
import { useConversationListContext } from "@/domains/chat/components/conversation-list-context";
import { useSectionConversations } from "@/domains/chat/use-section-conversations";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import { SidebarDiscButton } from "@/domains/chat/components/sidebar-disc-button";
import { useTranslation } from "@/i18n";
import type { Conversation } from "@/types/conversation-types";
import { SIDE_MENU_TILE_SIZE, Tooltip } from "@vellumai/design-library";

/**
 * The section's activity, read from the rows its card would show. While
 * those rows are not on screen, the dot their header would carry (a thread
 * waiting on the user, a reply the user has not seen) rides on the toggle
 * instead; callers drop it while the rows are showing, as the header does.
 */
function useSectionIndicator(
  conversations: Conversation[],
  section: SidebarSection,
): GroupIndicatorState {
  const { processingConversationIds, attentionConversationIds } =
    useConversationListContext();
  return getGroupIndicatorState(
    conversations,
    processingConversationIds,
    attentionConversationIds,
    section.unread,
  );
}

/**
 * The section's activity dot on the toggle's corner, where the collapsed
 * rail's tiles put theirs; ringed in the page ground so it reads as sitting
 * on the disc's edge rather than as a bite out of it. The offsets count from
 * inside the `Button`'s 1px border, so 2px puts the dot 1px past the disc.
 */
function IndicatorBadge({ state }: { state: GroupIndicatorState }) {
  return (
    <GroupIndicatorDot
      state={state}
      className="absolute -top-0.5 -right-0.5 ring-2 ring-[var(--surface-base)]"
    />
  );
}

export interface AssistantSectionToggleProps {
  assistantId: string | null;
  /** The assistant's own section, whose threads the toggle reveals. */
  section: SidebarSection;
  /** Names the assistant in the control's accessible name. */
  assistantName: string;
  open: boolean;
  onToggle: () => void;
}

/**
 * The round button beside the assistant pill that opens the assistant's own
 * section beneath it, drawn the size of the disc the eyes sit on. Its chat
 * glyph names what it reaches (her threads) and is the same in both states;
 * `aria-expanded` with the accessible name say which way the next press
 * goes.
 */
export function AssistantSectionToggle({
  assistantId,
  section,
  assistantName,
  open,
  onToggle,
}: AssistantSectionToggleProps) {
  const { t } = useTranslation("chat");
  /* The same query the section's card runs, so the dot reads the same rows
     the card shows and the card's rows are already loaded when it opens. */
  const { conversations } = useSectionConversations(assistantId, section);
  const indicator = useSectionIndicator(conversations, section);

  return (
    <SidebarDiscButton
      icon={MessageSquare}
      size={SIDEBAR_ASSISTANT_DISC_SIZE}
      badge={<IndicatorBadge state={open ? null : indicator} />}
      onClick={onToggle}
      aria-expanded={open}
      aria-label={t(
        open ? "assistantSectionToggle.hide" : "assistantSectionToggle.show",
        { name: assistantName },
      )}
    />
  );
}

export interface AssistantSectionRailToggleProps {
  assistantId: string | null;
  /** The assistant's own section, whose threads the flyout lists. */
  section: SidebarSection;
}

/**
 * The same toggle on the collapsed rail: a tile in the rail's column,
 * beneath the assistant's and above New Chat, where the row form stands
 * beside the pill. The rail has no room to open the card beneath it, so a
 * press opens the section's threads in a flyout beside the rail, the way
 * every rail tile opens its section, and at zero the flyout says what the
 * card would.
 */
export function AssistantSectionRailToggle({
  assistantId,
  section,
}: AssistantSectionRailToggleProps) {
  const { conversations, hasMore, loadMore } = useSectionConversations(
    assistantId,
    section,
  );
  const indicator = useSectionIndicator(conversations, section);

  return (
    <CollapsedFlyout
      trigger={(open) => (
        <Tooltip content={section.label} side="right">
          <SidebarDiscButton
            icon={MessageSquare}
            size={SIDE_MENU_TILE_SIZE}
            badge={<IndicatorBadge state={open ? null : indicator} />}
            aria-label={section.label}
            aria-haspopup="dialog"
            className="self-center"
          />
        </Tooltip>
      )}
    >
      {(close, scrollParent) =>
        conversations.length === 0 ? (
          <AssistantSectionEmptyState />
        ) : (
          <CollapsedGroupFlyout
            title={section.label}
            conversations={conversations}
            onClosePopover={close}
            scrollParent={scrollParent}
            onEndReached={hasMore ? loadMore : undefined}
          />
        )
      }
    </CollapsedFlyout>
  );
}
