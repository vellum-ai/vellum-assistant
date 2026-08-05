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
 *   the channel sections) keep their actions behind the header menu. Chats
 *   nests inside the persistent "Conversations" header in Grouped view (see
 *   `assistant-side-menu.tsx`), which owns the one visible "…" button.
 *
 * Everything else - the icon, the collapse behavior, the header menu, and
 * the section drag wiring - is uniform, and comes in already resolved. The
 * row list is the other near-exception: every section caps and scrolls
 * within itself except Pinned, which grows to fit its own rows instead
 * (see `unbounded` on `ConversationRowList`).
 */

import type { ReactNode } from "react";

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
}: SidebarSectionItemProps) {
  return (
    <ConversationNavSection
      value={section.key}
      icon={section.type === "pinned" ? undefined : sectionIcon(section)}
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
      // Pinned collapses like every other section (one component, one
      // behavior; its open state defaults open and persists like the
      // rest). It is the one section that never caps/scrolls internally:
      // it grows to fit its own rows instead.
      unbounded={section.type === "pinned"}
      {...rowListPropsFor(section)}
    />
  );
}
