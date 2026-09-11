/**
 * The two list-shaped pieces of the sidebar conversation list:
 *
 * - {@link ConversationRowList} - the one way conversation rows render as a
 *   list, used by every section and by the All view's flat list.
 * - {@link ConversationNavSection} — a `CollapsibleNavSection.Section`
 *   shell (icon + label + trailing + context menu) wrapping a
 *   `ConversationRowList`. Used by channel sections and custom groups.
 *
 * A windowed section paginates: `onEndReached` fires at the bottom of the
 * rows and pages more in (LUM-2444). What differs per section is where the
 * rows scroll. On the rail, only the bottom-most section (`isLast`) may
 * take whatever space the sidebar has left above the pinned footer: it hugs
 * its rows until they outgrow that space, then scrolls within itself. It
 * hugs rather than fills because a short list stretched into a card the
 * height of the rail is mostly empty surface. The one exception is a
 * windowed list, which fills: a virtualized list needs a definite height to
 * know what to render, and a list long enough to window has outgrown the
 * rail anyway.
 *
 * An expandable last section (`expandable`: Chats and the channel sections,
 * the two that accumulate without bound) rests at the same mid height every
 * non-last section caps at, so a hundred threads do not run the rail's
 * whole height by default, and grows to the full height on request (see
 * {@link SidebarExpandRow}). Either way the rows scroll inside it the same
 * way; only how much of the list is in view changes.
 *
 * Every section above the last one caps at a fixed height and scrolls
 * within itself instead, since an uncapped busy section would otherwise
 * push its neighbours off screen - unless it opts out via `unbounded`
 * (Pinned: expected to stay short, and grows to fit its rows instead). The
 * overlay drawer and the flat list instead scroll against the sidebar body
 * (`scrollParent` / `overlayCards`), which keeps those surfaces to a single
 * scrollbar so nested lists cannot trap rows behind the floating action
 * pills; neither has a height of its own to expand, so the control is the
 * rail's alone.
 *
 * Either way a list past {@link CONVERSATION_LIST_VIRTUALIZE_THRESHOLD} rows
 * windows rather than mounting every one, because an assistant accumulates
 * conversations indefinitely. Shorter lists mount directly and skip
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
import {
  SIDEBAR_SECTION_MAX_HEIGHT,
  SIDEBAR_SECTION_ROWS_WITHIN_CAP,
} from "@/components/sidebar-nav-geometry";
import { useConversationListContext } from "@/domains/chat/components/conversation-list-context";
import { ConversationRow } from "@/domains/chat/components/conversation-row";
import { LoadMoreSentinel } from "@/domains/chat/components/load-more-sentinel";
import { SidebarExpandRow } from "@/domains/chat/components/sidebar-expand-row";
import {
  hasAnyGroupMenuAction,
  renderGroupMenuItems,
  renderGroupMenuItemsAsPanelItems,
  type GroupMenuItemsProps,
} from "@/domains/chat/components/group-actions-menu";
import { useTranslation } from "@/i18n";
import type { Conversation } from "@/types/conversation-types";

/**
 * Row count past which a conversation list windows its rows instead of
 * mounting all of them. Below it the rows mount directly, which is the common
 * case and skips virtuoso's measuring pass.
 */
export const CONVERSATION_LIST_VIRTUALIZE_THRESHOLD = 30;

/**
 * Marks the windowed list's box so the section chain above it
 * (`SidebarSectionCard`, `CollapsibleNavSection.Section`) can switch the
 * last section from hugging its rows to filling the rail: a virtualized
 * list needs a definite height, and only the list knows which path it took.
 */
export const CONVERSATION_LIST_WINDOWED_SLOT = "conversation-list-windowed";

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
  /**
   * Fires when the user scrolls to the bottom of the rows - the load-more
   * trigger for a windowed list (LUM-2444). Pass only while more rows
   * exist; the virtualized path wires it to `VirtualList.endReached` and
   * the direct path renders a {@link LoadMoreSentinel} after the rows.
   */
  onEndReached?: () => void;
  /**
   * Caps this section's rows shorter than the shared
   * {@link SIDEBAR_SECTION_MAX_HEIGHT}, scrolling within itself past the
   * cap. The assistant-initiated section passes five rows' worth so its
   * realizations stay a glanceable stack. Ignored by `unbounded` and
   * ancestor-scrolled lists, which have no cap of their own to shrink.
   */
  maxHeight?: number;
  /**
   * Lets the section rest at {@link SIDEBAR_SECTION_MAX_HEIGHT} when it is
   * the rail's bottom-most (`isLast`) and offer an Expand control to take
   * the rail's full leftover height instead. Chats and the channel sections
   * pass it; a curated section (Pinned, a group) or one already capped (the
   * assistant's) does not. Inert off the rail and for `unbounded`.
   */
  expandable?: boolean;
  /** Whether an `expandable` section is at its full height. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export function ConversationRowList({
  items,
  scrollParent,
  unbounded,
  isLast,
  onEndReached,
  maxHeight,
  expandable,
  expanded = false,
  onExpandedChange,
}: ConversationRowListProps) {
  const { overlayCards, scrollParent: contextScrollParent } =
    useConversationListContext();
  const listScrollParent = scrollParent ?? contextScrollParent;
  /* Overlay cards and any list given an ancestor scroller grow with that
     ancestor. A nested `overflow-y-auto` on the overlay would trap its
     last rows behind the floating pills: the inner list cannot move those
     rows into the body's reserved padding. */
  const scrollWithBody = overlayCards === true || listScrollParent != null;

  /* The control appears only where there is a height to change and rows
     enough to need it: the rail's last section, with more rows than its
     mid height shows (or more still on the server). A section within its
     cap has nothing to expand into, and an expanded section that has since
     shrunk to fit keeps the control so it can be put back. */
  const canExpand =
    expandable === true && isLast === true && !unbounded && !scrollWithBody;
  const overflowsCap =
    items.length > SIDEBAR_SECTION_ROWS_WITHIN_CAP || onEndReached !== undefined;
  const expandRow =
    canExpand && (overflowsCap || expanded) ? (
      <SidebarExpandRow
        expanded={expanded}
        onToggle={() => onExpandedChange?.(!expanded)}
      />
    ) : null;
  const atMidHeight = canExpand && !expanded;

  const renderRow = (conversation: Conversation) => (
    <ConversationRow
      key={conversation.conversationId}
      conversation={conversation}
    />
  );

  const rows = (
    <SideMenu.SubList>
      {items.map(renderRow)}
      {onEndReached ? <LoadMoreSentinel onVisible={onEndReached} /> : null}
    </SideMenu.SubList>
  );

  const windows =
    !unbounded && items.length > CONVERSATION_LIST_VIRTUALIZE_THRESHOLD;

  if (!windows) {
    if (unbounded || scrollWithBody) {
      return rows;
    }
    /* The last section's list hugs its rows and shrinks under the rail's
       leftover space (no `flex-1`: the chain above only fills for a
       windowed list, see `CONVERSATION_LIST_WINDOWED_SLOT`), scrolling
       within itself once it is squeezed below its content. At its mid
       height it takes the same cap every non-last section does. The expand
       control is a sibling of the scroller, so it never scrolls out of
       reach. */
    return isLast ? (
      <>
        <div
          className="min-h-0 overflow-y-auto"
          style={
            atMidHeight ? { maxHeight: SIDEBAR_SECTION_MAX_HEIGHT } : undefined
          }
        >
          {rows}
        </div>
        {expandRow}
      </>
    ) : (
      <div
        className="overflow-y-auto"
        style={{ maxHeight: maxHeight ?? SIDEBAR_SECTION_MAX_HEIGHT }}
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
      customScrollParent={listScrollParent}
      computeItemKey={(_, conversation) => conversation.conversationId}
      itemContent={(_, conversation) => renderRow(conversation)}
      endReached={onEndReached}
      className={
        listScrollParent || scrollWithBody
          ? "bg-transparent"
          : "h-full bg-transparent"
      }
    />
  );

  if (scrollWithBody) {
    /* The overlay body's ref lands one commit after first paint. Until it
       does, mount the rows directly so a windowed list is not an empty
       virtuoso viewport with no scroll parent. */
    return listScrollParent ? windowed : rows;
  }

  /* Scrolling against an ancestor means no height of our own. Otherwise
     virtuoso's scroller sizes to 100%: the last section fills whatever
     height its own flex-fill sizing (see `CollapsibleNavSection.Section`)
     gives it, every other section gets a fixed height so a busy non-last
     section still can't push its neighbours off screen. A last section at
     its mid height takes the fixed height too: it is not filling anything.

     The last section's fill only resolves while every ancestor between the
     sidebar body and this box forwards the body's height (flex column with
     flex-1/min-h-0 at each layer). A windowed list renders only what fits
     its viewport, so unlike the mounted-rows path a broken chain here does
     not degrade to a tall list, it degrades to an empty one. The min-height
     floor caps that failure at "a section-sized scrollable box": rows stay
     reachable even if a layout change above drops the chain. */
  return isLast && !atMidHeight ? (
    <>
      <div
        data-slot={CONVERSATION_LIST_WINDOWED_SLOT}
        className="h-full min-h-0 flex-1"
        style={{ minHeight: SIDEBAR_SECTION_MAX_HEIGHT }}
      >
        {windowed}
      </div>
      {expandRow}
    </>
  ) : (
    <>
      <div style={{ height: maxHeight ?? SIDEBAR_SECTION_MAX_HEIGHT }}>
        {windowed}
      </div>
      {expandRow}
    </>
  );
}

export interface ConversationNavSectionProps extends ConversationRowListProps {
  /** Collapse/expand key (matches the controlling `CollapsibleNavSection.Root`). */
  value: string;
  label: string;
  icon?: LucideIcon;
  /** Leading glyph for a section whose mark is not a Lucide icon. */
  iconNode?: ReactNode;
  /** Forwarded to `CollapsibleNavSection.Section`: extra label-span classes. */
  labelClassName?: string;
  /** Forwarded to `CollapsibleNavSection.Section`: extra header-row classes. */
  headerClassName?: string;
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
  iconNode,
  labelClassName,
  headerClassName,
  trailing,
  groupMenu,
  collapsedIndicator,
  drag,
  collapsible,
  children,
  ...listProps
}: ConversationNavSectionProps) {
  const hasMenu = groupMenu != null && hasAnyGroupMenuAction(groupMenu);
  const { overlayCards } = useConversationListContext();
  const { t } = useTranslation("chat");

  return (
    <CollapsibleNavSection.Section
      value={value}
      card={overlayCards}
      icon={icon}
      iconNode={iconNode}
      label={label}
      labelClassName={labelClassName}
      headerClassName={headerClassName}
      trailing={trailing}
      contextMenuContent={
        hasMenu
          ? renderGroupMenuItems({ Primitive: ContextMenu, ...groupMenu, t })
          : undefined
      }
      touchMenuContent={
        hasMenu
          ? (close) =>
              renderGroupMenuItemsAsPanelItems({
                ...groupMenu,
                onClose: close,
                t,
              })
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
