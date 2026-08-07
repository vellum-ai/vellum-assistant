/**
 * One sidebar conversation section, whatever its type.
 *
 * This is the single render path for Pinned, Chats, every origin-channel
 * section, and every custom group - which is what keeps their spacing and
 * header treatment identical and lets the user interleave them freely
 * (LUM-2909). Only two things vary by type, and they're both here:
 *
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
import { useSectionConversations } from "@/domains/chat/use-section-conversations";
import { sectionIcon } from "@/domains/chat/utils/sidebar-section-icon";
import type { Conversation } from "@/types/conversation-types";

export interface SidebarSectionItemProps {
  section: SidebarSection;
  /** Owns this section's query; `null` keeps it on the derived rows. */
  assistantId: string | null;
  /**
   * Header actions, given the section's own rows. A function rather than a
   * built menu because the rows are resolved here: the sidebar decides what
   * the bulk actions *are*, this decides what they act on, so "mark all read"
   * covers every member rather than the ones that reached the foreground page.
   */
  groupMenu: (conversations: Conversation[]) => GroupMenuItemsProps;
  /** Section drag-reorder wiring; omit to pin the section in place. */
  drag?: CollapsibleNavSectionDrag;
  /** Activity dot shown in the header only while the section is collapsed. */
  collapsedIndicator?: (conversations: Conversation[]) => ReactNode;
}

export function SidebarSectionItem({
  section,
  assistantId,
  groupMenu: buildGroupMenu,
  drag,
  collapsedIndicator,
}: SidebarSectionItemProps) {
  const conversations = useSectionConversations(assistantId, section);

  /* A curated section with no members renders nothing, and waits for its
     first conversation. Decided here rather than in `use-sidebar-state`
     because this is the only place that knows the section's real contents:
     the hook upstream sees only what the foreground page happened to carry.

     Chats and the channel sections are excluded: Chats is the remainder and
     has to stay reachable even while empty, and a channel section only exists
     because it already has conversations. */
  const hidesWhenEmpty = section.type === "pinned" || section.type === "group";
  const groupMenu = buildGroupMenu(conversations);
  if (hidesWhenEmpty && conversations.length === 0) {
    return null;
  }
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
      collapsedIndicator={collapsedIndicator?.(conversations)}
      drag={drag}
      // Pinned collapses like every other section (one component, one
      // behavior; its open state defaults open and persists like the
      // rest). It is the one section that never caps/scrolls internally:
      // it grows to fit its own rows instead.
      unbounded={section.type === "pinned"}
      items={conversations}
    />
  );
}
