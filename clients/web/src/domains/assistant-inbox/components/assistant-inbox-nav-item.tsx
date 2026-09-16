import { Inbox } from "lucide-react";

import { PanelItem, SideMenu } from "@vellumai/design-library";

import { SIDEBAR_PILL_GAP_CLASSES } from "@/components/sidebar-nav-geometry";
import { useTranslation } from "@/i18n";

export interface AssistantInboxNavItemProps {
  active: boolean;
  collapsed: boolean;
  onSelect?: () => void;
}

/**
 * The sidebar entry that opens the Assistant Inbox. It sits directly above
 * Preferences at the foot of the rail, drawn the way that entry is drawn: a
 * content-width pill when the rail is expanded, and the round tile the rail
 * reduces every pill to when it collapses.
 */
export function AssistantInboxNavItem({
  active,
  collapsed,
  onSelect,
}: AssistantInboxNavItemProps) {
  const { t } = useTranslation("assistant-inbox");
  const label = t("assistantInboxNavItem.label");

  if (collapsed) {
    return (
      <SideMenu.Item
        icon={Inbox}
        label={label}
        showCollapsedTooltip
        shape="tile"
        active={active}
        onSelect={onSelect}
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
      className={SIDEBAR_PILL_GAP_CLASSES}
    />
  );
}
