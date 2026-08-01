/**
 * The two list-shaped pieces of the sidebar conversation list:
 *
 * - {@link ConversationRowList} - the one way conversation rows render as a
 *   list, used by every section and by the All view's flat list.
 * - {@link ConversationNavSection} — a `CollapsibleNavSection.Section`
 *   shell (icon + label + trailing + context menu) wrapping a
 *   `ConversationRowList`. Used by channel sections and custom groups.
 *
 * Nothing paginates: the rows just keep going. What differs is where they
 * scroll. A section caps at {@link SIDEBAR_SECTION_MAX_HEIGHT} and scrolls
 * within itself, since an uncapped busy section would push its neighbours off
 * screen. The flat list instead scrolls against the sidebar body it already
 * fills (`scrollParent`), which keeps the rail to a single scrollbar.
 *
 * Either way a list past {@link CONVERSATION_LIST_VIRTUALIZE_THRESHOLD} rows
 * windows rather than mounting every one, because an assistant accumulates
 * conversations indefinitely and they all arrive in one query: there is no
 * page to fetch, only rows to render. Shorter lists mount directly and skip
 * virtuoso's measuring pass.
 *
 * Row callbacks and state come from {@link useConversationListContext}
 * (via `ConversationRow`), so neither takes them as props.
 */

import { type ReactNode, type Ref } from "react";

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
 * Row count past which a conversation list windows its rows instead of
 * mounting all of them. Below it the rows mount directly, which is the common
 * case and skips virtuoso's measuring pass.
 */
export const CONVERSATION_LIST_VIRTUALIZE_THRESHOLD = 30;

export interface ConversationRowListProps {
  items: Conversation[];
  /** Drag-reorder section key; omit for non-reorderable lists. */
  dragSection?: string;
  /**
   * Full ordered list for drag math. Defaults to `items` — pass explicitly
   * only when the visible `items` are a subset.
   */
  dragSiblings?: Conversation[];
  /**
   * Scroll against this ancestor rather than bounding the list. Only the flat
   * list passes it: it already fills the sidebar body, so opening a scroller
   * of its own would put a second scrollbar in the rail.
   */
  scrollParent?: HTMLElement;
  /**
   * Reaches the bounded scroll div, for the Pinned resize handle to drive
   * imperatively during a drag. Unused when `scrollParent` unbounds the list.
   */
  listRef?: Ref<HTMLDivElement>;
  /** Caps the bounded list instead of {@link SIDEBAR_SECTION_MAX_HEIGHT}. */
  listMaxHeight?: number;
}

export function ConversationRowList({
  items,
  dragSection,
  dragSiblings,
  scrollParent,
  listRef,
  listMaxHeight,
}: ConversationRowListProps) {
  const renderRow = (conversation: Conversation) => (
    <ConversationRow
      key={conversation.conversationId}
      conversation={conversation}
      dragSection={dragSection}
      dragSiblings={dragSiblings ?? items}
    />
  );

  const rows = <SideMenu.SubList>{items.map(renderRow)}</SideMenu.SubList>;

  // Reorderable sections (Pinned, custom groups) always mount every row: the
  // drag controller resolves a drop target from the rows themselves, so a
  // windowed list would have nothing to drop onto past the viewport. They
  // stay bounded and scrollable either way, and they are the curated
  // sections, so they are the least likely to run long.
  const windows =
    !dragSection && items.length > CONVERSATION_LIST_VIRTUALIZE_THRESHOLD;

  if (!windows) {
    return scrollParent ? (
      rows
    ) : (
      <div
        ref={listRef}
        className="overflow-y-auto"
        style={{ maxHeight: listMaxHeight ?? SIDEBAR_SECTION_MAX_HEIGHT }}
      >
        {rows}
      </div>
    );
  }

  /* The primitive paints `--surface-base` for a list that owns its surface;
     every list here sits on a sidebar that has already painted its own. */
  const windowed = (
    <VirtualList
      items={items}
      customScrollParent={scrollParent}
      computeItemKey={(_, conversation) => conversation.conversationId}
      itemContent={(_, conversation) => renderRow(conversation)}
      className={scrollParent ? "bg-transparent" : "h-full bg-transparent"}
    />
  );

  /* Scrolling against an ancestor means no height of our own. Otherwise
     virtuoso's scroller sizes to 100%, so the wrapper commits to the full
     height, which is honest here since the list is past the cap. */
  return scrollParent ? (
    windowed
  ) : (
    <div
      ref={listRef}
      style={{ height: listMaxHeight ?? SIDEBAR_SECTION_MAX_HEIGHT }}
    >
      {windowed}
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
