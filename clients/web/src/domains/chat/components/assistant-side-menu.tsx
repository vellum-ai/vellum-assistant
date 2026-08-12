import { Search, X } from "lucide-react";
import {
  useCallback,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useCommandPaletteStore } from "@/stores/command-palette-store";

import { CollapsibleNavSection } from "@/components/collapsible-nav-section";
import { SIDEBAR_STACK_GAP } from "@/components/sidebar-nav-geometry";
import {
  getGroupIndicatorState,
  GroupIndicatorDot,
} from "@/domains/chat/components/collapsed-group-icon";
import { CollapsedRailSections } from "@/domains/chat/components/collapsed-rail-sections";
import {
  ConversationListProvider,
  type ConversationListContextValue,
} from "@/domains/chat/components/conversation-list-context";
import { SidebarListContextMenu } from "@/domains/chat/components/sidebar-list-context-menu";
import type { GroupMenuItemsProps } from "@/domains/chat/components/group-actions-menu";
import { SidebarSectionItem } from "@/domains/chat/components/sidebar-section-item";
import { SideMenuBuiltInNav } from "@/domains/chat/components/side-menu-built-in-nav";
import { SideMenuOverlayBottomColumn } from "@/domains/chat/components/side-menu-overlay-bottom-column";
import { SidebarBackToTop } from "@/domains/chat/components/sidebar-back-to-top";
import { SidebarConversationSkeleton } from "@/domains/chat/components/sidebar-conversation-skeleton";
import { useSectionDragReorder } from "@/domains/chat/hooks/use-section-drag-reorder";
import { useScrolledPast } from "@/domains/chat/hooks/use-scrolled-past";
import {
  useSidebarState,
  type SidebarSection,
  type UseSidebarStateParams,
} from "@/domains/chat/use-sidebar-state";
import { copyIdToClipboard } from "@/domains/chat/utils/copy-id-to-clipboard";
import { NATIVE_MOBILE_BARE_ICON_BUTTON } from "@/domains/chat/utils/native-mobile-button-constants";
import type { Conversation } from "@/types/conversation-types";
import { Button, cn, SideMenu } from "@vellumai/design-library";

export interface AssistantSideMenuProps extends UseSidebarStateParams {
  assistantName?: string | null;
  /**
   * The conversation list's first load is still in flight. Draws placeholder
   * rows instead of the (still empty) section tree, so a cold load reads as
   * loading rather than as an assistant with no conversations. Only consulted
   * while `conversations` is empty, so a background refetch over an already
   * populated sidebar never replaces live rows with placeholders.
   */
  isLoadingConversations?: boolean;
  collapsed: boolean;
  variant: "rail" | "overlay";
  width?: number;
  onWidthChange?: (width: number) => void;
  activeConversationId?: string;
  onSelectConversation: (key: string) => void;
  isIntelligenceActive?: boolean;
  onOpenIntelligence?: () => void;
  onOpenApp?: (appId: string) => void;
  activeAppId?: string;
  onStartNewConversation?: () => void;
  footerAction?: ReactNode;
  /**
   * Rendered above `footerAction` in the rail footer (hidden when collapsed)
   * and above the floating action pills on the overlay.
   */
  tipCard?: ReactNode;
  onClose?: () => void;

  onPinConversation?: (conversation: Conversation) => void;
  onRenameConversation?: (conversation: Conversation) => void;
  onArchiveConversation?: (conversation: Conversation) => void;
  onUnarchiveConversation?: (conversation: Conversation) => void;
  onMarkConversationUnread?: (conversation: Conversation) => void;
  onMarkConversationRead?: (conversation: Conversation) => void;
  /**
   * Create a new, empty custom group - the sidebar's own "New group…", as
   * opposed to {@link AssistantSideMenuProps.onCreateGroupInto}, which creates
   * a group around an existing conversation. Omit to drop the affordance.
   */
  onCreateGroup?: () => void;
  onRenameGroup?: (groupId: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  onMarkAllReadInGroup?: (conversations: Conversation[]) => void;
  onArchiveAllInGroup?: (
    groupName: string,
    conversations: Conversation[],
  ) => void;
  processingConversationIds?: Set<string>;
  activeConversationProcessing?: boolean;
  onOpenInNewWindow?: (conversation: Conversation) => void;
  onShareFeedback?: () => void;
  onInspect?: (conversation: Conversation) => void;
  /** Move a conversation into an existing custom group. */
  onMoveToGroup?: (conversation: Conversation, groupId: string) => void;
  /** Create a new custom group ("New group…") and move the conversation into it. */
  onCreateGroupInto?: (conversation: Conversation) => void;
  /** Remove a conversation from its current custom group (back to Recents). */
  onRemoveFromGroup?: (conversation: Conversation) => void;
}

/**
 * Top-edge fade for the overlay drawer's scrollport in Capacitor mobile
 * shells, where the close and search glyphs float over the list. The gradient
 * spans the whole 3.5rem reserve (`native-mobile:pt-14`), so a row is fully
 * transparent at the top of the glyph band and only reaches full opacity once
 * it has passed below the glyphs. The glyphs live in a sibling of the
 * scrollport, so the mask never dims them.
 *
 * Both declarations are spelled out in full because Tailwind only emits the
 * candidates it finds verbatim in source; the prefixed pairing follows
 * {@link VOICE_WAVE_EDGE_FADE_CLASS} in `voice-listening-waves.tsx`.
 */
const NATIVE_MOBILE_LIST_TOP_FADE =
  "native-mobile:[mask-image:linear-gradient(to_bottom,transparent,black_3.5rem)] native-mobile:[-webkit-mask-image:linear-gradient(to_bottom,transparent,black_3.5rem)]";

function SearchButton() {
  const toggle = useCommandPaletteStore.use.toggle();
  // Leaves the drawer open: the palette (fixed z-50) covers it, so dismissing
  // search returns to the menu rather than the chat behind it.
  const handleClick = useCallback(() => {
    toggle();
  }, [toggle]);
  return (
    <Button
      variant="ghost"
      iconOnly={<Search />}
      aria-label="Search (⌘K)"
      title="Search (⌘K)"
      className={`pointer-events-auto ${NATIVE_MOBILE_BARE_ICON_BUTTON}`}
      onClick={handleClick}
    />
  );
}

/**
 * Assistant sidebar content.
 *
 * Structure (top → bottom):
 *
 *   Header
 *     • Your Assistant → Intelligence view, with New Chat beneath it
 *   Body · one section list, in the user's own order (default shown)
 *     • Pinned ▾       - when non-empty
 *     • Group ▾        - one collapsible section per custom group
 *     • Chats ▾        - whatever the curated sections did not claim. Present
 *       in both views; its "…" menu carries the channel-grouping toggle
 *       ("Group by channel" / "Ungroup by channel")
 *     • Channel ▾      - grouped view only: one section per origin channel
 *       (Slack, Telegram, WhatsApp, …). Ungrouped, those conversations are
 *       in Chats instead, so which section a conversation appears in changes
 *       but whether it appears does not
 *   Footer
 *     • caller-provided tip card (SidebarTipCard), hidden on the collapsed rail
 *     • caller-provided action (PreferencesMenu)
 *
 * This component does **not** know that order. `useSidebarState` hands it one
 * flat `sections` array already sorted by the user's stored preference, and
 * every section renders through the same path - which is what lets a custom
 * group sit above Recents, and what keeps the spacing between any two
 * sections identical.
 *
 * Every section is a peer: same shell, same header treatment, same drag
 * handle, and no divider anywhere in the list. A custom group is not a
 * different class of thing from Pinned or a channel section, so nothing here
 * may imply a grouping the user didn't create (LUM-2909).
 *
 * The conversation rows, row lists, and collapsible sections are
 * components ({@link ConversationRow} / {@link ConversationRowList} /
 * {@link ConversationNavSection}); their shared action callbacks and state
 * flow through {@link ConversationListProvider}.
 */
export function AssistantSideMenu({
  isLoadingConversations,
  assistantId,
  assistantName,
  collapsed,
  variant,
  width,
  onWidthChange,
  conversations,
  activeConversationId,
  onSelectConversation,
  isIntelligenceActive = false,
  onOpenIntelligence,
  onOpenApp,
  activeAppId,
  onStartNewConversation,
  footerAction,
  tipCard,
  onPinConversation,
  onRenameConversation,
  onArchiveConversation,
  onUnarchiveConversation,
  onMarkConversationUnread,
  onMarkConversationRead,
  conversationGroups,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onMarkAllReadInGroup,
  onArchiveAllInGroup,
  onClose,
  processingConversationIds,
  attentionConversationIds,
  activeConversationProcessing,
  onOpenInNewWindow,
  onShareFeedback,
  onInspect,
  onMoveToGroup,
  onCreateGroupInto,
  onRemoveFromGroup,
}: AssistantSideMenuProps) {
  const sidebar = useSidebarState({
    assistantId,
    conversations,
    conversationGroups,
    attentionConversationIds,
  });

  const isCollapsedRail = collapsed && variant === "rail";
  /* Mirrors `SideMenu`'s own condition for mounting the resize handle. */
  const isResizable = variant === "rail" && !collapsed && onWidthChange != null;

  /* Gated on an empty list, not on the loading flag alone: a refetch over a
     populated sidebar keeps drawing the rows it already has rather than
     blanking them back to placeholders. */
  const showConversationSkeleton =
    isLoadingConversations === true && conversations.length === 0;

  // --- Overlay bottom reserve ---
  // The overlay's floating bottom column (tip card + action pills) covers the
  // scrollable body, so the body reserves matching bottom padding to keep the
  // last conversation rows scrollable clear of it. Measured (not static)
  // because the tip card appears/disappears and its copy length varies.
  // The scrollport the flat "All" list virtualizes against. State, not a ref,
  // because the list only mounts once the node exists and has to re-render
  // when it does.
  const [bodyElement, setBodyElement] = useState<HTMLElement | null>(null);

  // Far enough down that the pill never flickers in on a nudge, and short
  // enough that it is there by the time the curated layer is off screen.
  const scrolledPast = useScrolledPast(bodyElement, 400);

  // Reported by SideMenuOverlayBottomColumn; only read while the overlay
  // variant is up, so a stale value from a dismissed overlay is inert.
  const [overlayBottomColumnHeight, setOverlayBottomColumnHeight] = useState(0);

  // Whole-section reordering. Rows themselves do not reorder: every section
  // is recency-sorted (LUM-3108).
  const sectionDragFor = useSectionDragReorder({
    sections: sidebar.sections,
    onReorder: sidebar.onReorderSections,
  });

  // Header actions for a sidebar section. Every section gets the same shape —
  // Pinned, Chats, each channel section, and each custom group — so the bulk
  // actions are identical everywhere and the only per-section difference is
  // the rename/delete pair that custom groups additionally own.
  const buildGroupMenu = (
    groupName: string,
    conversations: Conversation[],
    options?: {
      onRename?: () => void;
      onDelete?: () => void;
      onCopyGroupId?: () => void;
      onMoveUp?: () => void;
      onMoveDown?: () => void;
      onToggleGroupByChannel?: () => void;
      isGroupedByChannel?: boolean;
    },
  ): GroupMenuItemsProps => ({
    onMoveUp: options?.onMoveUp,
    onMoveDown: options?.onMoveDown,
    onToggleGroupByChannel: options?.onToggleGroupByChannel,
    isGroupedByChannel: options?.isGroupedByChannel,
    onMarkAllRead: onMarkAllReadInGroup
      ? () => onMarkAllReadInGroup(conversations)
      : undefined,
    hasUnreadConversations: onMarkAllReadInGroup
      ? conversations.some((c) => c.hasUnseenLatestAssistantMessage)
      : false,
    onArchiveAll: onArchiveAllInGroup
      ? () => onArchiveAllInGroup(groupName, conversations)
      : undefined,
    hasConversations: conversations.length > 0,
    onRename: options?.onRename,
    onDelete: options?.onDelete,
    onCopyGroupId: options?.onCopyGroupId,
  });

  const selectAndClose = useCallback(
    (key: string) => {
      onSelectConversation(key);
      onClose?.();
    },
    [onSelectConversation, onClose],
  );

  // Shared context for every conversation row (Pinned, Recents, channel
  // sections, custom groups, rail flyout): the action callbacks,
  // active/processing/attention state, and drag controller the rows read.
  // Activity dot for a collapsed section header — surfaces processing/unread
  // conversations that live in a collapsed section (attention already
  // force-opens the section via effectiveOpen*). Null when the section is idle.
  const collapsedActivityDot = (
    conversations: Conversation[],
    section: SidebarSection,
  ): ReactNode => {
    const state = getGroupIndicatorState(
      conversations,
      processingConversationIds,
      attentionConversationIds,
      section.unread,
    );
    return state ? <GroupIndicatorDot state={state} /> : null;
  };

  const listContext: ConversationListContextValue = {
    activeConversationId,
    activeConversationProcessing,
    processingConversationIds,
    attentionConversationIds,
    onSelect: selectAndClose,
    onPin: onPinConversation,
    onRename: onRenameConversation,
    onArchive: onArchiveConversation,
    onUnarchive: onUnarchiveConversation,
    onMarkRead: onMarkConversationRead,
    onMarkUnread: onMarkConversationUnread,
    onOpenInNewWindow,
    onShareFeedback,
    onInspect,
    conversationGroups,
    onMoveToGroup,
    onCreateGroupInto,
    onRemoveFromGroup,
  };

  // Header actions for one section: the bulk actions every section shares,
  // the move-up/down pair its position allows (absent when the move would do
  // nothing, which is how the menu avoids offering a dead action), and - for
  // custom groups only - rename/delete/copy-id.
  const sectionMenu = (
    section: SidebarSection,
    conversations: Conversation[],
  ): GroupMenuItemsProps => {
    const moveOptions = {
      onMoveUp: sidebar.canMoveSection(section.key, -1)
        ? () => sidebar.onMoveSection(section.key, -1)
        : undefined,
      onMoveDown: sidebar.canMoveSection(section.key, 1)
        ? () => sidebar.onMoveSection(section.key, 1)
        : undefined,
    };
    /* Chats and the channel sections are what the view switch reshapes, so
       they carry the toggle for it. Same menu as a custom group otherwise;
       where a group offers rename and delete, these offer the switch. */
    const isGoverned = section.type === "recents" || section.type === "channel";
    if (section.type !== "group") {
      return buildGroupMenu(section.label, conversations, {
        ...moveOptions,
        ...(isGoverned
          ? {
              onToggleGroupByChannel: () =>
                sidebar.onViewModeChange(
                  sidebar.viewMode === "grouped" ? "all" : "grouped",
                ),
              isGroupedByChannel: sidebar.viewMode === "grouped",
            }
          : {}),
      });
    }
    return buildGroupMenu(section.label, conversations, {
      ...moveOptions,
      onRename: onRenameGroup
        ? () => onRenameGroup(section.group.id)
        : undefined,
      onDelete: onDeleteGroup
        ? () => onDeleteGroup(section.group.id)
        : undefined,
      onCopyGroupId: () => copyIdToClipboard(section.group.id, "Group ID"),
    });
  };

  const renderSection = (section: SidebarSection, index: number) => (
    <SidebarSectionItem
      key={section.key}
      section={section}
      assistantId={assistantId ?? null}
      groupMenu={(conversations) => sectionMenu(section, conversations)}
      drag={sectionDragFor(section)}
      collapsedIndicator={collapsedActivityDot}
      // Only the bottom-most section ever claims the sidebar's leftover
      // space (see `unbounded` on `ConversationRowList`): flex-grow doesn't
      // know which open section "needs" the room, so giving every open
      // section a share stretched a small one (e.g. a two-row group) into a
      // near-empty box the same size as a busy one beside it.
      isLast={index === sidebar.sections.length - 1}
    />
  );

  // Rendered in the rail's non-scrolling header, or at the top of the
  // overlay's body so the whole menu scrolls as one surface; the block's
  // composition rules live on SideMenuBuiltInNav.
  const builtInNav = (
    <SideMenuBuiltInNav
      assistantId={assistantId ?? null}
      assistantName={assistantName}
      collapsed={collapsed}
      variant={variant}
      isIntelligenceActive={isIntelligenceActive}
      onOpenIntelligence={onOpenIntelligence}
      onStartNewConversation={onStartNewConversation}
      activeAppId={activeAppId}
      onOpenApp={onOpenApp}
      onClose={onClose}
    />
  );

  // --- JSX ---

  return (
    <ConversationListProvider value={listContext}>
      <SideMenu
        ariaLabel="Assistant navigation"
        collapsed={collapsed}
        variant={variant}
        width={width}
        onWidthChange={onWidthChange}
        /* The cards and pills carry the surface, so the panel behind them is
           the page background and the rail carries no chrome of its own: no
           border, no fill, and no padding, which leaves the page layout's
           own padding as the drawer's only inset and lets the cards span the
           rail's full width. The overlay keeps the component's padding - it
           is a full-bleed sheet whose inset is all that keeps content off the
           screen edges.

           The resize handle sits in the rail's last 6px, and the cards are
           their own drag handles for section reordering, so the scrollport
           holds that strip clear: overlapped, a grab on a card's right edge
           resizes the rail instead of picking the section up. */
        className={cn(
          "relative h-full border-0 bg-transparent",
          variant === "rail" && (isResizable ? "p-0 pr-[6px]" : "p-0"),
        )}
      >
        <SideMenu.Header>
          {variant === "overlay" ? (
            /* Close on the left, Search pinned to the right so it stays put
               and always reads as the persistent search affordance
               (Figma 6788:6749). In Capacitor mobile shells the row floats
               over the scrollport so list content travels beneath the bare
               glyphs; `pointer-events-none` keeps the empty span between the
               two buttons scrollable. */
            <div className="flex items-center justify-between gap-2 native-mobile:pointer-events-none native-mobile:absolute native-mobile:inset-x-4 native-mobile:top-4 native-mobile:z-10">
              <Button
                variant="ghost"
                iconOnly={<X />}
                aria-label="Close navigation"
                className={`pointer-events-auto ${NATIVE_MOBILE_BARE_ICON_BUTTON}`}
                onClick={() => onClose?.()}
              />
              <SearchButton />
            </div>
          ) : (
            builtInNav
          )}
        </SideMenu.Header>

        <SideMenu.Body
          ref={setBodyElement}
          className={
            variant === "overlay"
              ? /* pb-24 is a coarse floating-column reserve until the measured
                 inline padding below is applied. The native-mobile pt-14
                 clears the 40px floating icon row plus a 16px gap. */
                `-mx-4 ${SIDEBAR_STACK_GAP} px-4 pb-24 native-mobile:pt-14 ${NATIVE_MOBILE_LIST_TOP_FADE}`
              : /* The top inset is the same stack gap: the header closes
                   with no rule, so without it the first card (or the
                   collapsed rail's first group icon) butts against the
                   last pill while every other pair is spaced. */
                `${SIDEBAR_STACK_GAP} pt-2`
          }
          style={
            variant === "overlay" && overlayBottomColumnHeight > 0
              ? ({
                  /* The floating column overlaps the scrollport by its own
                     height + the safe-area inset (its 1rem bottom offset
                     cancels against the root's p-4); + 1rem breathing gap. */
                  "--overlay-bottom-column-h": `${overlayBottomColumnHeight}px`,
                  paddingBottom:
                    "calc(var(--overlay-bottom-column-h) + 1rem + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
                } as CSSProperties)
              : undefined
          }
        >
          {/* The overlay puts the assistant cluster at the top of the
              scrollport rather than in a fixed header, so it owns the inset
              that keeps it clear of the floating close and search glyphs.
              Restates the body's own gap, which wrapping these into one
              flex item would otherwise drop. */}
          {variant === "overlay" ? (
            <div
              className={cn(
                "flex flex-col pt-3 max-md:pt-4",
                SIDEBAR_STACK_GAP,
              )}
            >
              {builtInNav}
            </div>
          ) : null}
          {isCollapsedRail ? (
            <CollapsedRailSections
              sections={sidebar.sections}
              assistantId={assistantId ?? null}
              processingConversationIds={processingConversationIds}
              attentionConversationIds={attentionConversationIds}
            />
          ) : showConversationSkeleton ? (
            <SidebarConversationSkeleton />
          ) : (
            /* Right-clicking the list (including the empty space below the
               last section) creates a group, so the affordance covers the
               whole scrollport rather than any one section. */
            <>
              <SidebarListContextMenu onCreateGroup={onCreateGroup}>
                {/* Every section - Pinned, Chats, channels, custom groups -
                  shares one accordion root, so its gap is the only thing
                  between any two of them and the spacing is uniform by
                  construction. Their open state lives in three storage buckets
                  with different defaults (Pinned/Chats open);
                  `use-sidebar-state` merges and re-splits it. New Chat lives in
                  the assistant cluster above, not as a section-header
                  action. */}
                <CollapsibleNavSection.Root
                  type="multiple"
                  className={SIDEBAR_STACK_GAP}
                  value={sidebar.effectiveOpenSections}
                  onValueChange={sidebar.onOpenSectionsChange}
                >
                  {/* Every section is a card, in the user's own order, with
                    nothing between them: the cards' own surfaces are what
                    separate one from the next, so the list needs no rule and
                    no wrapping header. Each section's menu carries the
                    Group by toggle, which is why removing the persistent
                    "Conversations" header loses nothing. */}
                  {sidebar.sections.map(renderSection)}
                </CollapsibleNavSection.Root>
              </SidebarListContextMenu>
              <SidebarBackToTop
                visible={scrolledPast}
                onClick={() =>
                  bodyElement?.scrollTo({ top: 0, behavior: "smooth" })
                }
              />
            </>
          )}
        </SideMenu.Body>

        {variant === "overlay" ? (
          <SideMenuOverlayBottomColumn
            tipCard={tipCard}
            footerAction={footerAction}
            onStartNewConversation={onStartNewConversation}
            onClose={onClose}
            onHeightChange={setOverlayBottomColumnHeight}
          />
        ) : footerAction || tipCard ? (
          /* Every entry in this sidebar is a pill on the page background, and
             a shape like that is already delimited: a line above the last one
             would divide a column that reads as grouped without it. The
             footer's own top padding is the whole separation, and `mt-auto`
             on `SideMenu.Footer` is what holds it at the bottom while the
             list scrolls in `SideMenu.Body` above it. */
          <SideMenu.Footer>
            {/* The collapsed rail drops the tip card (per design). */}
            {isCollapsedRail ? null : tipCard}
            {footerAction}
          </SideMenu.Footer>
        ) : null}
      </SideMenu>
    </ConversationListProvider>
  );
}
