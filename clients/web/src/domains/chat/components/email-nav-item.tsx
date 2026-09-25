import { Mail, PinOff } from "lucide-react";

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

export interface EmailNavItemProps {
  /** Whose inbox this opens; the pill wears that assistant's accent. */
  assistantId: string | null;
  collapsed: boolean;
  onSelect?: () => void;
  /** Take the pin off the side menu again. */
  onUnpin?: () => void;
}

/**
 * The side menu's pin for the assistant's Email, drawn under the pinned
 * apps once the user pins it from the profile's Email card. Coloured the
 * way the New Chat button is, washed in the assistant's accent with the
 * glyph in that colour: it is about the assistant, so it carries the
 * assistant's colour. No `active` state, like New Chat: the inbox taking
 * over the main area is what says where you are. Collapsed, it is the
 * icon tile the rail draws its other entries as.
 */
export function EmailNavItem({
  assistantId,
  collapsed,
  onSelect,
  onUnpin,
}: EmailNavItemProps) {
  const { t } = useTranslation("chat");
  const { accentHex } = useAssistantAvatar(assistantId);
  const label = t("emailNavItem.label");

  const tint: CustomPropertyStyle | undefined = accentHex
    ? {
        ...panelItemWashStyle(accentHex),
        "--panel-item-icon-fg": accentHex,
      }
    : undefined;

  if (collapsed) {
    return (
      <SidebarIconTile
        icon={Mail}
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
      icon={Mail}
      label={label}
      onSelect={onSelect}
      style={tint}
      className={SIDEBAR_PILL_GAP_CLASSES}
      /* Drawn the way the pinned-app pill draws its unpin: a 24px box on
         the trailing edge, revealed on hover, a 36px touch target on a
         phone. */
      trailingAction={
        onUnpin ? (
          <button
            type="button"
            aria-label={t("emailNavItem.unpin")}
            onClick={(event) => {
              event.stopPropagation();
              onUnpin();
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded-[4px] text-[var(--content-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)] max-md:-my-2 max-md:size-9 max-md:rounded-full"
          >
            <PinOff size={14} aria-hidden className="max-md:size-4" />
          </button>
        ) : undefined
      }
    />
  );
}
