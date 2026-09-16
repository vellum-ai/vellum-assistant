import { Inbox } from "lucide-react";

import {
  PanelItem,
  panelItemWashStyle,
  SideMenu,
  type CustomPropertyStyle,
} from "@vellumai/design-library";

import { SIDEBAR_PILL_GAP_CLASSES } from "@/components/sidebar-nav-geometry";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";

export interface AssistantInboxNavItemProps {
  /** Whose inbox this opens; the pill wears that assistant's accent. */
  assistantId: string | null;
  active: boolean;
  collapsed: boolean;
  onSelect?: () => void;
}

/**
 * The sidebar entry that opens the Assistant Inbox. It sits directly above
 * Preferences at the foot of the rail, but it is drawn the way the New Chat
 * row under the identity pill is drawn, not the way Preferences is: washed
 * in the assistant's accent with the glyph in that same colour. Preferences
 * is about the app; this entry, like New Chat, is about the assistant, so
 * it carries the assistant's colour. A content-width pill when the rail is
 * expanded, the round tile the rail reduces every pill to when it collapses.
 *
 * With no character avatar to draw a hue from, the wash is omitted and the
 * entry falls back to the plain pill surface the rest of the rail uses.
 */
export function AssistantInboxNavItem({
  assistantId,
  active,
  collapsed,
  onSelect,
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
      <SideMenu.Item
        icon={Inbox}
        label={label}
        showCollapsedTooltip
        shape="tile"
        active={active}
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
      active={active}
      onSelect={onSelect}
      style={tint}
      className={SIDEBAR_PILL_GAP_CLASSES}
    />
  );
}
