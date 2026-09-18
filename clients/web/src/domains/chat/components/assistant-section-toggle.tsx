import { MessageSquare } from "lucide-react";
import { useState, type ComponentProps } from "react";

import { AssistantSectionEmptyState } from "@/domains/chat/components/assistant-section-empty-state";
import {
  getGroupIndicatorState,
  GroupIndicatorDot,
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
import { toneForBg } from "@/utils/avatar-tone";
import {
  cn,
  Popover,
  SIDE_MENU_TILE_SIZE,
  Tooltip,
} from "@vellumai/design-library";

interface AssistantSectionDiscProps extends ComponentProps<"button"> {
  assistantId: string | null;
  /** Diameter, in px. */
  size: number;
  /** The section's activity, or null while its rows are on screen. */
  indicator: GroupIndicatorState;
}

/**
 * The toggle's disc, shared by its row and rail forms: a circle in the
 * avatar's colour carrying a chat glyph, which names what the button
 * reaches (her threads). The glyph is drawn at the size every other leading
 * icon in the rail is.
 *
 * While the section's rows are not on screen, the activity dot their header
 * would carry (a thread waiting on the user, a reply the user has not seen)
 * rides on the disc instead, in the corner the collapsed rail's tiles put
 * theirs.
 *
 * Every other prop reaches the button, so the rail form's popover trigger
 * can compose its handlers and ref onto it.
 */
function AssistantSectionDisc({
  assistantId,
  size,
  indicator,
  className,
  ...rest
}: AssistantSectionDiscProps) {
  const { accentHex } = useAssistantAvatar(assistantId);
  return (
    <button
      type="button"
      {...rest}
      /* After the spread: the popover and tooltip triggers each clone their
         own slot name onto the rail form's disc, and it stays this one. */
      data-slot="assistant-section-toggle"
      className={cn(
        "relative flex shrink-0 cursor-pointer items-center justify-center rounded-full",
        "transition-[filter,transform] duration-150 active:scale-[0.98]",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        /* No avatar colour to wear (an uploaded image, or a still-loading
           avatar): the plain raised surface every untinted row falls back
           to. */
        accentHex
          ? "[@media(hover:hover)]:hover:brightness-105"
          : "bg-[var(--surface-active)] text-[var(--content-default)] [@media(hover:hover)]:hover:bg-[var(--surface-hover)]",
        className,
      )}
      style={{
        width: size,
        height: size,
        /* The glyph's ink by the avatar surfaces' own rule: black on the
           light colour (yellow), white on every other. */
        ...(accentHex
          ? { backgroundColor: accentHex, color: toneForBg(accentHex).fg }
          : undefined),
      }}
    >
      <MessageSquare aria-hidden className="size-3.5 max-md:size-4" />
      {indicator ? (
        <GroupIndicatorDot
          state={indicator}
          /* Ringed in the page ground so it reads as sitting on the disc's
             edge rather than as a bite out of it. */
          className="absolute -top-px -right-px ring-2 ring-[var(--surface-base)]"
        />
      ) : null}
    </button>
  );
}

/** The section's activity dot, read from the rows its card would show. */
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
 * section beneath it, drawn the size of the disc the eyes sit on. The glyph
 * is the same in both states; `aria-expanded` with the accessible name say
 * which way the next press goes. Open, the rows show their own state and
 * the dot steps aside, as the header's does.
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
  const indicator = useSectionIndicator(conversations, section, open);

  return (
    <AssistantSectionDisc
      assistantId={assistantId}
      size={SIDEBAR_ASSISTANT_DISC_SIZE}
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
  const [contentEl, setContentEl] = useState<HTMLElement | null>(null);
  const { conversations, hasMore, loadMore } = useSectionConversations(
    assistantId,
    section,
  );
  const indicator = useSectionIndicator(conversations, section, open);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Tooltip content={section.label} side="right">
          <AssistantSectionDisc
            assistantId={assistantId}
            size={SIDE_MENU_TILE_SIZE}
            indicator={indicator}
            aria-label={section.label}
            aria-haspopup="dialog"
            className="self-center"
          />
        </Tooltip>
      </Popover.Trigger>
      <Popover.Content
        ref={setContentEl}
        side="right"
        align="start"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="max-h-[500px] w-72 overflow-y-auto rounded-lg py-2 px-0"
      >
        {conversations.length === 0 ? (
          <AssistantSectionEmptyState />
        ) : (
          <CollapsedGroupFlyout
            title={section.label}
            conversations={conversations}
            onClosePopover={() => setOpen(false)}
            scrollParent={contentEl}
            onEndReached={hasMore ? loadMore : undefined}
          />
        )}
      </Popover.Content>
    </Popover.Root>
  );
}
