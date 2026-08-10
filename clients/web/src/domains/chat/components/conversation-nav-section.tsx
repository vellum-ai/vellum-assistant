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
 * scroll. Only the bottom-most section (`isLast`) grows to fill whatever
 * space the sidebar has left above the pinned footer, then scrolls within
 * itself once its rows outgrow that: flex-grow has no notion of "this
 * section needs the room," so letting every open section claim a share
 * stretched a two-row group into a mostly-empty box the same size as a busy
 * one beside it. Every section above the last one caps at a fixed height
 * and scrolls within itself instead, since an uncapped busy section would
 * otherwise push its neighbours off screen - unless it opts out via
 * `unbounded` (Pinned: expected to stay short, and grows to fit its rows
 * instead). The flat list instead scrolls against the sidebar body it
 * already fills (`scrollParent`), which keeps the rail to a single
 * scrollbar.
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
 * Row count past which a conversation list windows its rows instead of
 * mounting all of them. Below it the rows mount directly, which is the common
 * case and skips virtuoso's measuring pass.
 */
export const CONVERSATION_LIST_VIRTUALIZE_THRESHOLD = 30;

export interface ConversationRowListProps {
  items: Conversation[];
  /**
   * Scroll against this ancestor rather than bounding the list. Only the flat
   * list passes it: it already fills the sidebar body, so opening a scroller
   * of its own would put a second scrollbar in the rail.
   */
  scrollParent?: HTMLElement;
  /**
   * Skips the sizing below entirely: the list grows to fit every row
   * instead. Pinned is the one section that wants this, the user's own
   * curation, expected to stay short - and (unlike Chats or a channel
   * section) not something that should ever push its neighbours off screen.
   */
  unbounded?: boolean;
  /**
   * Whether this is the bottom-most section in the list. It grows to fill
   * whatever space the sidebar has left, then scrolls within itself past
   * that. Every other section caps at {@link SIDEBAR_SECTION_MAX_HEIGHT}
   * instead and scrolls sooner, so it can't stretch past its own content
   * just because the flex column had room to give it.
   */
  isLast?: boolean;
}

export function ConversationRowList({
  items,
  scrollParent,
  unbounded,
  isLast,
}: ConversationRowListProps) {
  const renderRow = (conversation: Conversation) => (
    <ConversationRow
      key={conversation.conversationId}
      conversation={conversation}
    />
  );

  const rows = <SideMenu.SubList>{items.map(renderRow)}</SideMenu.SubList>;

  const windows =
    !unbounded && items.length > CONVERSATION_LIST_VIRTUALIZE_THRESHOLD;

  if (!windows) {
    if (unbounded) {
      return rows;
    }
    if (scrollParent) {
      return rows;
    }
    return isLast ? (
      <div className="min-h-0 flex-1 overflow-y-auto">{rows}</div>
    ) : (
      <div
        className="overflow-y-auto"
        style={{ maxHeight: SIDEBAR_SECTION_MAX_HEIGHT }}
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

  if (scrollParent) {
    return windowed;
  }

  /* Scrolling against an ancestor means no height of our own. Otherwise
     virtuoso's scroller sizes to 100%: the last section fills whatever
     height its own flex-fill sizing (see `CollapsibleNavSection.Section`)
     gives it, every other section gets a fixed height so a busy non-last
     section still can't push its neighbours off screen. */
  return isLast ? (
    <div className="min-h-0 h-full flex-1">{windowed}</div>
  ) : (
    <div style={{ height: SIDEBAR_SECTION_MAX_HEIGHT }}>{windowed}</div>
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
  /** Forwarded to `CollapsibleNavSection.Section`; defaults to `true`. */
  collapsible?: boolean;
  /**
   * Overrides the default `ConversationRowList` content, e.g. nested
   * sub-sections instead of a row list. `items`/pagination/drag props are
   * still required by the type but go unused when this is provided.
   */
  children?: ReactNode;
}

export function ConversationNavSection({
  value,
  label,
  icon,
  trailing,
  groupMenu,
  collapsedIndicator,
  drag,
  collapsible,
  children,
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
      collapsible={collapsible}
      unbounded={listProps.unbounded}
      isLast={listProps.isLast}
    >
      {children ?? <ConversationRowList {...listProps} />}
    </CollapsibleNavSection.Section>
  );
}
