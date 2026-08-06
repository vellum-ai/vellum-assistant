/**
 * The header glyph for a sidebar section, for every section type.
 *
 * Pure and exhaustive on purpose: it is the one place that answers "what does
 * this section look like", so the expanded list and the collapsed rail can't
 * disagree, and adding a section type is a compile error here rather than a
 * bare header somewhere.
 *
 * Resolution goes through the same two registries every other surface uses -
 * `channel-presentation` for origin channels, `group-icon-registry` for the
 * icon a user picked for a custom group.
 */

import { MessageSquare, Pin, type LucideIcon } from "lucide-react";

import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import {
  DEFAULT_GROUP_ICON,
  getGroupIcon,
} from "@/domains/chat/utils/group-icon-registry";
import { getChannelIcon } from "@/utils/channel-presentation";

/**
 * The Chats section's label and glyph. Named here because the All view's
 * collapsed-rail tile stands in for a section that isn't in the list, so it
 * has no {@link SidebarSection} to read them from and would otherwise restate
 * both.
 */
export const RECENTS_SECTION_LABEL = "Chats";
export const RECENTS_SECTION_ICON: LucideIcon = MessageSquare;

export function sectionIcon(section: SidebarSection): LucideIcon {
  switch (section.type) {
    case "pinned":
      return Pin;
    case "recents":
      return RECENTS_SECTION_ICON;
    case "channel":
      return getChannelIcon(section.channelId);
    case "group":
      return getGroupIcon(section.group.icon) ?? DEFAULT_GROUP_ICON;
  }
}
