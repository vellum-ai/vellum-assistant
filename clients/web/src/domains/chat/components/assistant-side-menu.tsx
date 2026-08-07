import { Search, X } from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useCommandPaletteStore } from "@/stores/command-palette-store";

import { CollapsibleNavSection } from "@/components/collapsible-nav-section";
import { SIDEBAR_SECTION_TITLE_TEXT_CLASSES } from "@/components/sidebar-nav-geometry";
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
import {
  ConversationNavSection,
  ConversationRowList,
} from "@/domains/chat/components/conversation-nav-section";
import { GroupActionsMenu } from "@/domains/chat/components/group-actions-menu";
import { SideMenuBuiltInNav } from "@/domains/chat/components/side-menu-built-in-nav";
import { SideMenuOverlayBottomColumn } from "@/domains/chat/components/side-menu-overlay-bottom-column";
import { SidebarViewModeSelect } from "@/domains/chat/components/sidebar-view-mode-select";
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
 *     • ───────────────
 *   Body · one section list, in the user's own order (default shown)
 *     • Pinned ▾       - when non-empty
 *     • Group ▾        - one collapsible section per custom group
 *     • ───────────────  - the list's one rule, when anything is curated
 *       above it; never between two sections
 *     • Conversations  - the persistent header; its "…" menu carries the
 *       "Group by" dropdown (None | Channel)
 *     • Group by None: every remaining conversation as one headerless,
 *       virtualized list, newest first
 *     • Group by Channel: Chats ▾ then one collapsible section per
 *       origin channel (Slack, Telegram, WhatsApp, …)
 *   Footer
 *     • caller-provided tip card (SidebarTipCard) — hidden on the collapsed rail
 *     • ───────────────
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
    },
  ): GroupMenuItemsProps => ({
    onMoveUp: options?.onMoveUp,
    onMoveDown: options?.onMoveDown,
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
  const collapsedActivityDot = (conversations: Conversation[]): ReactNode => {
    const state = getGroupIndicatorState(
      conversations,
      processingConversationIds,
      attentionConversationIds,
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
  const sectionMenu = (section: SidebarSection): GroupMenuItemsProps => {
    const moveOptions = {
      onMoveUp: sidebar.canMoveSection(section.key, -1)
        ? () => sidebar.onMoveSection(section.key, -1)
        : undefined,
      onMoveDown: sidebar.canMoveSection(section.key, 1)
        ? () => sidebar.onMoveSection(section.key, 1)
        : undefined,
    };
    if (section.type !== "group") {
      return buildGroupMenu(section.label, section.all, moveOptions);
    }
    return buildGroupMenu(section.label, section.all, {
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

  // Grouping dropdown, in the persistent "Conversations" header's menu.
  const groupByFooter = (
    <div className="px-2 pb-1">
      <div className={cn("mt-3 mb-2", SIDEBAR_SECTION_TITLE_TEXT_CLASSES)}>
        Group by
      </div>
      <SidebarViewModeSelect
        value={sidebar.viewMode}
        onChange={sidebar.onViewModeChange}
      />
    </div>
  );

  const renderSection = (section: SidebarSection) => (
    <SidebarSectionItem
      key={section.key}
      section={section}
      groupMenu={sectionMenu(section)}
      drag={sectionDragFor(section)}
      collapsedIndicator={collapsedActivityDot(section.all)}
    />
  );

  // Everything the persistent "Conversations" header contains, which is
  // whatever its body renders: the flat list in `all`, and the sections below
  // the curated tier in `grouped`.
  //
  // Both branches describe the same set of conversations, just partitioned
  // differently, so the header's bulk actions reach the same rows either way.
  // Reading `flatList` in both views would not: it is the `all` view's list,
  // so in `grouped` it holds only what is left once the channel sections take
  // their conversations, and the actions would silently skip every Slack and
  // Telegram row the header visibly contains.
  const governedConversations = useMemo(
    () =>
      sidebar.viewMode === "all"
        ? sidebar.flatList
        : sidebar.sections
            .slice(sidebar.curatedSectionCount)
            .flatMap((section) => section.all),
    [
      sidebar.viewMode,
      sidebar.flatList,
      sidebar.sections,
      sidebar.curatedSectionCount,
    ],
  );

  // The persistent "Conversations" header: same bulk-action menu shape as a
  // section's, minus move-up/down since it isn't a member of
  // `sidebar.sections`.
  const conversationsMenu = buildGroupMenu(
    "Conversations",
    governedConversations,
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
        className="relative h-full border-0"
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
                `-mx-4 gap-4 px-4 pb-24 native-mobile:pt-14 ${NATIVE_MOBILE_LIST_TOP_FADE}`
              : /* The collapsed rail tucks the group icons up under the
                 cluster separator (~12px to the first icon tile) so they
                 read as the next section, not a distant island. */
                isCollapsedRail
                ? "gap-4 pt-2"
                : /* The scrollport spans the full rail so its scrollbar rides
                     the outer edge instead of cutting through the content, and
                     takes over the horizontal inset the root would have given
                     it, so rows sit exactly where they did. No top inset: the
                     first section sits flush against the header. */
                  "-mx-4 gap-4 px-4"
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
              `gap-4` restates the body's own gap, which wrapping these into
              one flex item would otherwise drop. */}
          {variant === "overlay" ? (
            <div className="flex flex-col gap-4 pt-3 max-md:pt-4">
              {builtInNav}
            </div>
          ) : null}
          {isCollapsedRail ? (
            <CollapsedRailSections
              sections={sidebar.sections}
              viewMode={sidebar.viewMode}
              flatList={sidebar.flatList}
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
                  className="gap-3"
                  value={sidebar.effectiveOpenSections}
                  onValueChange={sidebar.onOpenSectionsChange}
                >
                  {/* Pinned and the custom groups: the user's own curation,
                    identical in both views. Nothing between them - they flow
                    together as one curated block, and only the block's own
                    rule below marks the boundary to Conversations. */}
                  {sidebar.sections
                    .slice(0, sidebar.curatedSectionCount)
                    .map(renderSection)}
                  {/* The list's one rule, marking where curation ends and the
                    conversations begin. Absent when nothing is curated yet, so
                    a fresh sidebar never opens on a stray line. Sits on the
                    root's own gap, pulled up 2px so the curated block's last
                    row sits closer to it than the root's default gap-3.
                    Static: Pinned no longer caps/scrolls (it's `unbounded`
                    now, see `ConversationRowList`), so there's nothing left
                    to resize here. */}
                  {sidebar.curatedSectionCount > 0 ? (
                    <div
                      data-slot="sidebar-section-rule"
                      role="separator"
                      aria-orientation="horizontal"
                      style={{ marginTop: -2 }}
                      className="h-px w-full bg-[var(--border-base)]"
                    />
                  ) : null}
                  {/* "Conversations" is the persistent header for everything
                    that isn't Pinned or a custom group: it never swaps out
                    for "Chats". Grouped by All, its content is the flat
                    list; grouped by Channels, Chats and each channel
                    section nest inside it instead of sitting as its
                    top-level siblings, keeping their own headers/collapse
                    behavior. Same bulk-action menu machinery as a
                    section's, minus move-up/down since it isn't a member
                    of `sidebar.sections`. */}
                  <ConversationNavSection
                    value="conversations"
                    label="Conversations"
                    collapsible={false}
                    trailing={
                      <GroupActionsMenu
                        label="Conversations"
                        footer={groupByFooter}
                        {...conversationsMenu}
                      />
                    }
                    groupMenu={conversationsMenu}
                    items={sidebar.flatList}
                  >
                    {sidebar.viewMode === "all" ? (
                      bodyElement ? (
                        <ConversationRowList
                          items={sidebar.flatList}
                          scrollParent={bodyElement}
                        />
                      ) : null
                    ) : (
                      <div className="flex flex-col gap-3">
                        {sidebar.sections
                          .slice(sidebar.curatedSectionCount)
                          .map(renderSection)}
                      </div>
                    )}
                  </ConversationNavSection>
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
          // `pt-0`, and a flush separator, so the conversation list runs right
          // up to the rule instead of trailing off into dead space.
          <SideMenu.Footer className="pt-0">
            {/* Tip card first, divider between it and the footer action. The
               collapsed rail drops both (per design). */}
            {isCollapsedRail ? null : tipCard}
            {isCollapsedRail ? null : <SideMenu.Separator className="my-0" />}
            {footerAction}
          </SideMenu.Footer>
        ) : null}
      </SideMenu>
    </ConversationListProvider>
  );
}
