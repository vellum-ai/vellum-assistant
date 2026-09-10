import { ChevronUp, MessageSquare } from "lucide-react";

import {
  getGroupIndicatorState,
  GroupIndicatorDot,
} from "@/domains/chat/components/collapsed-group-icon";
import { useConversationListContext } from "@/domains/chat/components/conversation-list-context";
import { useSectionConversations } from "@/domains/chat/use-section-conversations";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";
import { contrastForeground } from "@/utils/avatar-tone";
import { cn } from "@vellumai/design-library";

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
 * section beneath it: a disc in the avatar's colour, the pill's own solid
 * surface, carrying a chat glyph while the section is closed and a chevron
 * while it is open, so the control says what pressing it does next.
 *
 * While the section is closed its header is not on screen, so the activity
 * dot that header would carry (a thread waiting on the user, a reply the
 * user has not seen) rides on this button instead, in the corner the
 * collapsed rail's tiles put theirs. Open, the rows show their own state
 * and the dot steps aside, as the header's does.
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
  const { processingConversationIds, attentionConversationIds } =
    useConversationListContext();
  const indicator = open
    ? null
    : getGroupIndicatorState(
        conversations,
        processingConversationIds,
        attentionConversationIds,
        section.unread,
      );
  const Glyph = open ? ChevronUp : MessageSquare;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={t(
        open ? "assistantSectionToggle.hide" : "assistantSectionToggle.show",
        { name: assistantName },
      )}
      data-slot="assistant-section-toggle"
      className={cn(
        "relative flex shrink-0 cursor-pointer items-center justify-center rounded-full",
        "size-[var(--side-menu-tile-size,36px)]",
        "shadow-[var(--shadow-lg)] transition-[filter,transform] duration-150 active:scale-[0.98]",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        /* No avatar colour to wear (an uploaded image, or a still-loading
           avatar): the plain raised surface every untinted row falls back
           to. */
        accentHex
          ? "[@media(hover:hover)]:hover:brightness-105"
          : "bg-[var(--surface-active)] text-[var(--content-default)] [@media(hover:hover)]:hover:bg-[var(--surface-hover)]",
      )}
      style={
        accentHex
          ? { backgroundColor: accentHex, color: contrastForeground(accentHex) }
          : undefined
      }
    >
      <Glyph aria-hidden className="size-4" />
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
