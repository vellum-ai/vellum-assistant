import { Inbox, X } from "lucide-react";

import {
  PanelItem,
  panelItemWashStyle,
  SIDE_MENU_TILE_SIZE,
  type CustomPropertyStyle,
} from "@vellumai/design-library";

import { SidebarIconTile } from "@/components/sidebar-icon-tile";
import { SIDEBAR_PILL_GAP_CLASSES } from "@/components/sidebar-nav-geometry";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";

export interface AssistantInboxNavItemProps {
  /** Whose inbox this opens; the pill wears that assistant's accent. */
  assistantId: string | null;
  collapsed: boolean;
  onSelect?: () => void;
  /**
   * Hide the entry. Offered on a plan without managed email, where the inbox
   * is a pitch rather than a place, so someone who will never want it can
   * take the entry off the rail. Absent once there is an inbox to open.
   */
  onDismiss?: () => void;
}

/**
 * The sidebar entry that opens the Assistant Inbox. It sits directly above
 * Preferences at the foot of the rail, but it is coloured the way the New
 * Chat button is, not the way Preferences is: washed in the assistant's
 * accent, with the glyph in that same colour, and the wash deepening on
 * hover. Preferences is about the app; this entry, like New Chat, is about
 * the assistant, so it carries the assistant's colour.
 *
 * Like New Chat it takes no `active` state. The pill's selected treatment
 * recolours the glyph to the default ink, which would undo the accent, and
 * its selected surface is the same raised mix hover uses, so the two would
 * be indistinguishable. The inbox taking over the main area is what says
 * where you are.
 *
 * Collapsed, it is the same icon tile New Chat is drawn as, at the rail's
 * tile size.
 *
 * With no character avatar to draw a hue from, the wash is omitted and the
 * entry falls back to the plain pill surface the rest of the rail uses.
 */
export function AssistantInboxNavItem({
  assistantId,
  collapsed,
  onSelect,
  onDismiss,
}: AssistantInboxNavItemProps) {
  const { t } = useTranslation("assistant-inbox");
  const { accentHex } = useAssistantAvatar(assistantId);
  const label = t("assistantInboxNavItem.label");

  const tint: CustomPropertyStyle | undefined = accentHex
    ? {
        ...panelItemWashStyle(accentHex),
        "--panel-item-icon-fg": accentHex,
      }
    : undefined;

  if (collapsed) {
    return (
      <SidebarIconTile
        icon={Inbox}
        label={label}
        tooltipSide="right"
        size={SIDE_MENU_TILE_SIZE}
        onSelect={onSelect}
        style={tint}
      />
    );
  }

  return (
    <PanelItem
      shape="pill"
      icon={Inbox}
      label={label}
      onSelect={onSelect}
      style={tint}
      className={SIDEBAR_PILL_GAP_CLASSES}
      /* Held visible rather than hover-revealed: the dismiss is the reason
         the pill offers a trailing action at all, and a person deciding
         they never want the inbox should not have to discover it. */
      revealHold={Boolean(onDismiss)}
      /* Drawn the way the pinned-app pill draws its unpin: a 24px box on
         the trailing edge, a 36px touch target on a phone. */
      trailingAction={
        onDismiss ? (
          <button
            type="button"
            aria-label={t("assistantInboxNavItem.dismiss")}
            onClick={(event) => {
              event.stopPropagation();
              onDismiss();
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded-[4px] text-[var(--content-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)] max-md:-my-2 max-md:size-9 max-md:rounded-full"
          >
            <X size={14} aria-hidden className="max-md:size-4" />
          </button>
        ) : undefined
      }
    />
  );
}
