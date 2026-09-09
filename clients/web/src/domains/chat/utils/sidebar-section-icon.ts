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

import { Inbox, MessageSquare, Pin, type LucideIcon } from "lucide-react";

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

/**
 * Fallback header for the assistant-initiated section, used when the assistant
 * has no name of its own. Named assistants render "From <name>" instead — the
 * section is a person rather than a category, and "Your Assistant" (the
 * unnamed placeholder the switcher pill shows) reads badly as a section
 * header.
 */
export const ASSISTANT_SECTION_LABEL = "On My Mind";

/**
 * Header for the assistant-initiated section: `"From <name>"` once the
 * assistant has a name, {@link ASSISTANT_SECTION_LABEL} before it does.
 *
 * The named form is the point — it makes the section a person rather than a
 * category, which is the whole reason these threads are worth separating from
 * Chats. The fallback exists because the unnamed placeholder the switcher pill
 * shows ("Your Assistant") reads as a settings row rather than a byline, so an
 * unnamed assistant gets a neutral header instead of "From Your Assistant".
 *
 * Whitespace-only names fall back too: the name is user-entered, and `"From "`
 * with nothing after it is worse than either real option.
 */
export function assistantSectionLabel(
  assistantName: string | null | undefined,
): string {
  const trimmed = assistantName?.trim();
  return trimmed ? `From ${trimmed}` : ASSISTANT_SECTION_LABEL;
}

export function sectionIcon(section: SidebarSection): LucideIcon {
  switch (section.type) {
    case "pinned":
      return Pin;
    case "assistant":
      /* The tray her threads arrive in. Deliberately NOT the eyes or the
         brain: the eyes are the assistant herself and stay exclusive to the
         cluster at the top of the rail, the brain belongs to that cluster's
         menu item, and reusing either here made the section read as a second
         switcher. Inbox frames the section from the user's side - things
         sent to you - and no other section uses it. */
      return Inbox;
    case "recents":
      return RECENTS_SECTION_ICON;
    case "channel":
      return getChannelIcon(section.channelId);
    case "group":
      return getGroupIcon(section.group.icon) ?? DEFAULT_GROUP_ICON;
  }
}
