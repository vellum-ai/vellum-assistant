import { MessageSquare } from "lucide-react";

import {
  getGroupIndicatorState,
  GroupIndicatorDot,
} from "@/domains/chat/components/collapsed-group-icon";
import { SIDEBAR_ASSISTANT_DISC_SIZE } from "@/components/sidebar-nav-geometry";
import { useConversationListContext } from "@/domains/chat/components/conversation-list-context";
import { useSectionConversations } from "@/domains/chat/use-section-conversations";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";
import { toneForBg } from "@/utils/avatar-tone";
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
 * section beneath it: a disc the size of the one the eyes sit on, in the
 * avatar's colour, carrying a chat glyph in both states: the glyph names
 * what the button reaches (her threads), and `aria-expanded` with the
 * accessible name say which way the next press goes. The glyph is drawn at
 * the size every other leading icon in the rail is.
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
        "transition-[filter,transform] duration-150 active:scale-[0.98]",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        /* No avatar colour to wear (an uploaded image, or a still-loading
           avatar): the plain raised surface every untinted row falls back
           to. */
        accentHex
          ? "[@media(hover:hover)]:hover:brightness-105"
          : "bg-[var(--surface-active)] text-[var(--content-default)] [@media(hover:hover)]:hover:bg-[var(--surface-hover)]",
      )}
      style={{
        width: SIDEBAR_ASSISTANT_DISC_SIZE,
        height: SIDEBAR_ASSISTANT_DISC_SIZE,
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
