/**
 * The two list-shaped pieces of the sidebar conversation list:
 *
 * - {@link ConversationRowList} — a `SideMenu.SubList` of
 *   {@link ConversationRow}s, bounded and scrollable. Used directly by
 *   Pinned and Recents, and inside every collapsible section.
 * - {@link ConversationNavSection} — a `CollapsibleNavSection.Section`
 *   shell (icon + label + trailing + context menu) wrapping a
 *   `ConversationRowList`. Used by channel sections and custom groups.
 *
 * Every section scrolls rather than paginating, so all of them behave the way
 * the All view's flat list does: no "Show more", the rows just keep going.
 * The cap ({@link SIDEBAR_SECTION_MAX_HEIGHT}) is what makes that safe in a
 * stack of sections, since an uncapped busy section would push its
 * neighbours off screen.
 *
 * Row callbacks and state come from {@link useConversationListContext}
 * (via `ConversationRow`), so neither takes them as props.
 */

import { type ReactNode } from "react";

import { type LucideIcon } from "lucide-react";

import { ContextMenu, SideMenu } from "@vellumai/design-library";
import { VirtualList } from "@vellumai/design-library/components/virtual-list";

import {
  CollapsibleNavSection,
  type CollapsibleNavSectionDrag,
} from "@/components/collapsible-nav-section";
import { SIDEBAR_SECTION_MAX_HEIGHT } from "@/components/sidebar-nav-geometry";
import { ConversationRow } from "@/domains/chat/components/conversation-row";
import {
  hasAnyGroupMenuAction,
  renderGroupMenuItems,
  renderGroupMenuItemsAsPanelItems,
  type GroupMenuItemsProps,
} from "@/domains/chat/components/group-actions-menu";
import type { Conversation } from "@/types/conversation-types";

/**
 * Row count past which a section windows its rows instead of mounting all of
 * them. Below it the rows mount directly, which is the common case and skips
 * virtuoso's measuring pass.
 */
const VIRTUALIZE_THRESHOLD = 30;

export interface ConversationRowListProps {
  items: Conversation[];
  /** Drag-reorder section key; omit for non-reorderable lists. */
  dragSection?: string;
  /**
   * Full ordered list for drag math. Defaults to `items` — pass explicitly
   * only when the visible `items` are a subset.
   */
  dragSiblings?: Conversation[];
}

export function ConversationRowList({
  items,
  dragSection,
  dragSiblings,
}: ConversationRowListProps) {
  const renderRow = (conversation: Conversation) => (
    <ConversationRow
      key={conversation.conversationId}
      conversation={conversation}
      dragSection={dragSection}
      dragSiblings={dragSiblings ?? items}
    />
  );

  // Reorderable sections (Pinned, custom groups) always mount every row: the
  // drag controller resolves a drop target from the rows themselves, so a
  // windowed list would have nothing to drop onto past the viewport. They
  // stay bounded and scrollable either way, and they are the curated
  // sections, so they are the least likely to run long.
  if (!dragSection && items.length > VIRTUALIZE_THRESHOLD) {
    return (
      /* Virtuoso's scroller sizes to 100%, so this branch commits to the full
         height — which is honest here, since the list is past the cap. */
      <div style={{ height: SIDEBAR_SECTION_MAX_HEIGHT }}>
        <VirtualList
          items={items}
          computeItemKey={(_, conversation) => conversation.conversationId}
          itemContent={(_, conversation) => renderRow(conversation)}
          className="h-full bg-transparent"
        />
      </div>
    );
  }

  return (
    <div
      className="overflow-y-auto"
      style={{ maxHeight: SIDEBAR_SECTION_MAX_HEIGHT }}
    >
      <SideMenu.SubList>{items.map(renderRow)}</SideMenu.SubList>
    </div>
  );
}

export interface ConversationNavSectionProps extends ConversationRowListProps {
  /** Collapse/expand key (matches the controlling `CollapsibleNavSection.Root`). */
  value: string;
  label: string;
  icon?: LucideIcon;
  trailing?: ReactNode;
  /**
   * Bulk/group actions for this section's header. Rendered as a right-click
   * context menu on desktop and a long-press bottom sheet on touch — both
   * from this one prop, so the two surfaces can't drift. Omit (or pass a
   * props object with no callbacks) for a section with no header actions.
   */
  groupMenu?: GroupMenuItemsProps;
  /** Activity dot shown in the header only while the section is collapsed. */
  collapsedIndicator?: ReactNode;
  /** Section-level drag-to-reorder wiring; omit to pin the section in place. */
  drag?: CollapsibleNavSectionDrag;
}

export function ConversationNavSection({
  value,
  label,
  icon,
  trailing,
  groupMenu,
  collapsedIndicator,
  drag,
  ...listProps
}: ConversationNavSectionProps) {
  const hasMenu = groupMenu != null && hasAnyGroupMenuAction(groupMenu);

  return (
    <CollapsibleNavSection.Section
      value={value}
      icon={icon}
      label={label}
      trailing={trailing}
      contextMenuContent={
        hasMenu
          ? renderGroupMenuItems({ Primitive: ContextMenu, ...groupMenu })
          : undefined
      }
      touchMenuContent={
        hasMenu
          ? (close) =>
              renderGroupMenuItemsAsPanelItems({ ...groupMenu, onClose: close })
          : undefined
      }
      collapsedIndicator={collapsedIndicator}
      drag={drag}
    >
      <ConversationRowList {...listProps} />
    </CollapsibleNavSection.Section>
  );
}
