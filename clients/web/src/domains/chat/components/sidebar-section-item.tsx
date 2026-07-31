/**
 * One sidebar conversation section, whatever its type.
 *
 * This is the single render path for Pinned, Chats, every origin-channel
 * section, and every custom group - which is what keeps their spacing and
 * header treatment identical and lets the user interleave them freely
 * (LUM-2909). Only three things vary by type, and they're all here:
 *
 * - **Whether rows drag.** Only the sections that honor `displayOrder`
 *   (Pinned, custom groups) offer row-level reordering - the rest stay
 *   recency-sorted, so dragging a row in them would have nothing to persist.
 * - **Whether the header carries a "…" button.** The curated sections (Pinned
 *   and the custom groups) get one, so their actions are reachable without
 *   knowing to right-click. It reveals on hover; the derived sections (Chats,
 *   the channel sections) keep their actions behind the header menu.
 *
 * Everything else - the icon, the collapse behavior, the header menu, the
 * section drag wiring, and the bounded scrolling row list - is uniform, and
 * comes in already resolved.
 */

import type { ReactNode, Ref } from "react";

import type { CollapsibleNavSectionDrag } from "@/components/collapsible-nav-section";
import { ConversationNavSection } from "@/domains/chat/components/conversation-nav-section";
import {
  GroupActionsMenu,
  type GroupMenuItemsProps,
} from "@/domains/chat/components/group-actions-menu";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import { sectionIcon } from "@/domains/chat/utils/sidebar-section-icon";

export interface SidebarSectionItemProps {
  section: SidebarSection;
  /** Header actions, already wired by the sidebar (bulk, rename, move). */
  groupMenu: GroupMenuItemsProps;
  /** Section drag-reorder wiring; omit to pin the section in place. */
  drag?: CollapsibleNavSectionDrag;
  /** Activity dot shown in the header only while the section is collapsed. */
  collapsedIndicator?: ReactNode;
  /** Reaches the row list's bounded scroll div (the sidebar wires Pinned's). */
  listRef?: Ref<HTMLDivElement>;
  /** Caps the row list instead of the shared section max height. */
  listMaxHeight?: number;
}

/**
 * Row-list props for a section. Both branches carry the same keys so the
 * spread below stays a single object type rather than a union.
 */
function rowListPropsFor(section: SidebarSection) {
  if (section.type === "recents" || section.type === "channel") {
    return { items: section.all, dragSection: undefined };
  }
  return {
    items: section.all,
    dragSection:
      section.type === "pinned" ? "pinned" : `group:${section.key}`,
  };
}

export function SidebarSectionItem({
  section,
  groupMenu,
  drag,
  collapsedIndicator,
  listRef,
  listMaxHeight,
}: SidebarSectionItemProps) {
  return (
    <ConversationNavSection
      value={section.key}
      icon={sectionIcon(section)}
      label={section.label}
      /* The "…" button and the header's right-click menu both render from
         `groupMenu`; only the curated sections carry the button. */
      trailing={
        section.type === "group" || section.type === "pinned" ? (
          <GroupActionsMenu label={section.label} {...groupMenu} />
        ) : undefined
      }
      groupMenu={groupMenu}
      collapsedIndicator={collapsedIndicator}
      drag={drag}
      listRef={listRef}
      listMaxHeight={listMaxHeight}
      {...rowListPropsFor(section)}
    />
  );
}
