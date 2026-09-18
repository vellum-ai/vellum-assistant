import { MessageSquare } from "lucide-react";
import { useState } from "react";

import { AssistantAccentDisc } from "@/domains/chat/components/assistant-accent-disc";
import { AssistantSectionEmptyState } from "@/domains/chat/components/assistant-section-empty-state";
import {
  CollapsedFlyoutContent,
  getGroupIndicatorState,
  type GroupIndicatorState,
} from "@/domains/chat/components/collapsed-group-icon";
import { CollapsedGroupFlyout } from "@/domains/chat/components/conversation-rail-flyout";
import { SIDEBAR_ASSISTANT_DISC_SIZE } from "@/components/sidebar-nav-geometry";
import { useConversationListContext } from "@/domains/chat/components/conversation-list-context";
import { useSectionConversations } from "@/domains/chat/use-section-conversations";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";
import type { Conversation } from "@/types/conversation-types";
import {
  Popover,
  SIDE_MENU_TILE_SIZE,
  Tooltip,
} from "@vellumai/design-library";

/**
 * The section's activity dot, read from the rows its card would show. While
 * those rows are not on screen, the dot their header would carry (a thread
 * waiting on the user, a reply the user has not seen) rides on the toggle
 * instead; while they are, it steps aside, as the header's does.
 */
function useSectionIndicator(
  conversations: Conversation[],
  section: SidebarSection,
  showing: boolean,
): GroupIndicatorState {
  const { processingConversationIds, attentionConversationIds } =
    useConversationListContext();
  return showing
    ? null
    : getGroupIndicatorState(
        conversations,
        processingConversationIds,
        attentionConversationIds,
        section.unread,
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
  const { accentHex } = useAssistantAvatar(assistantId);
  /* The same query the section's card runs, so the dot reads the same rows
     the card shows and the card's rows are already loaded when it opens. */
  const { conversations } = useSectionConversations(assistantId, section);
  const indicator = useSectionIndicator(conversations, section, open);

  return (
    <AssistantAccentDisc
      icon={MessageSquare}
      accentHex={accentHex}
      size={SIDEBAR_ASSISTANT_DISC_SIZE}
      slot="assistant-section-toggle"
      indicator={indicator}
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
  const [open, setOpen] = useState(false);
  const { accentHex } = useAssistantAvatar(assistantId);
  const { conversations, hasMore, loadMore } = useSectionConversations(
    assistantId,
    section,
  );
  const indicator = useSectionIndicator(conversations, section, open);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Tooltip content={section.label} side="right">
          <AssistantAccentDisc
            icon={MessageSquare}
            accentHex={accentHex}
            size={SIDE_MENU_TILE_SIZE}
            slot="assistant-section-toggle"
            indicator={indicator}
            aria-label={section.label}
            aria-haspopup="dialog"
            className="self-center"
          />
        </Tooltip>
      </Popover.Trigger>
      <CollapsedFlyoutContent>
        {(scrollParent) =>
          conversations.length === 0 ? (
            <AssistantSectionEmptyState />
          ) : (
            <CollapsedGroupFlyout
              title={section.label}
              conversations={conversations}
              onClosePopover={() => setOpen(false)}
              scrollParent={scrollParent}
              onEndReached={hasMore ? loadMore : undefined}
            />
          )
        }
      </CollapsedFlyoutContent>
    </Popover.Root>
  );
}
