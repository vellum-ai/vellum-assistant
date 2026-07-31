import { Search, SquarePen, X } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useCommandPaletteStore } from "@/stores/command-palette-store";

import { CollapsibleNavSection } from "@/components/collapsible-nav-section";
import {
  CollapsedGroupIcon,
  getGroupIndicatorState,
  GroupIndicatorDot,
} from "@/domains/chat/components/collapsed-group-icon";
import {
  ConversationListProvider,
  type ConversationListContextValue,
} from "@/domains/chat/components/conversation-list-context";
import { SidebarListContextMenu } from "@/domains/chat/components/sidebar-list-context-menu";
import { CollapsedGroupFlyout } from "@/domains/chat/components/conversation-rail-flyout";
import type { GroupMenuItemsProps } from "@/domains/chat/components/group-actions-menu";
import { SidebarSectionItem } from "@/domains/chat/components/sidebar-section-item";
import { ConversationRowList } from "@/domains/chat/components/conversation-nav-section";
import { SidebarViewModeToggle } from "@/domains/chat/components/sidebar-view-mode-toggle";
import { SidebarBackToTop } from "@/domains/chat/components/sidebar-back-to-top";
import { AssistantNavItem } from "@/domains/chat/components/assistant-nav-item";
import { PinnedAppNavItem } from "@/domains/chat/components/pinned-app-nav-item";
import { useDragReorder } from "@/domains/chat/hooks/use-drag-reorder";
import { useSectionDragReorder } from "@/domains/chat/hooks/use-section-drag-reorder";
import { useScrolledPast } from "@/domains/chat/hooks/use-scrolled-past";
import {
  useSidebarState,
  type SidebarSection,
  type UseSidebarStateParams,
} from "@/domains/chat/use-sidebar-state";
import { SidebarSectionResizeHandle } from "@/domains/chat/components/sidebar-section-resize-handle";
import { copyIdToClipboard } from "@/domains/chat/utils/copy-id-to-clipboard";
import { NATIVE_IOS_BARE_ICON_BUTTON } from "@/domains/chat/utils/native-ios-button-constants";
import {
  resetPinnedSectionHeight,
  savePinnedSectionHeight,
  usePinnedSectionHeight,
} from "@/domains/chat/utils/sidebar-pinned-height";
import {
  RECENTS_SECTION_ICON,
  RECENTS_SECTION_LABEL,
  sectionIcon,
} from "@/domains/chat/utils/sidebar-section-icon";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { Conversation } from "@/types/conversation-types";
import { Button, SideMenu } from "@vellumai/design-library";

export interface AssistantSideMenuProps extends UseSidebarStateParams {
  assistantName?: string | null;
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
  /**
   * Persist a drag-reorder within a section. Receives the section's full
   * conversation list in its new order. When omitted, rows aren't draggable.
   * Only sections that honor `displayOrder` (Pinned, custom groups) offer
   * drag-reordering — Recents and channel sections stay recency-sorted.
   */
  onReorderConversations?: (conversations: Conversation[]) => void;
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
 * Top-edge fade for the overlay drawer's scrollport on the Capacitor iOS
 * shell, where the close and search glyphs float over the list. The gradient
 * spans the whole 3.5rem reserve (`native-ios:pt-14`), so a row is fully
 * transparent at the top of the glyph band and only reaches full opacity once
 * it has passed below the glyphs. The glyphs live in a sibling of the
 * scrollport, so the mask never dims them.
 *
 * Both declarations are spelled out in full because Tailwind only emits the
 * candidates it finds verbatim in source; the prefixed pairing follows
 * {@link VOICE_WAVE_EDGE_FADE_CLASS} in `voice-listening-waves.tsx`.
 */
const NATIVE_IOS_LIST_TOP_FADE =
  "native-ios:[mask-image:linear-gradient(to_bottom,transparent,black_3.5rem)] native-ios:[-webkit-mask-image:linear-gradient(to_bottom,transparent,black_3.5rem)]";

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
      className={`pointer-events-auto ${NATIVE_IOS_BARE_ICON_BUTTON}`}
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
 *     • [ All | Grouped ] - the view switch, first and sticky
 *     • Pinned ▾       - when non-empty
 *     • Group ▾        - one collapsible section per custom group
 *     • ───────────────  - when anything is curated above it; drags to
 *       resize Pinned while that section is expanded
 *     • All view: every remaining conversation as one headerless,
 *       virtualized list, newest first
 *     • Grouped view: Chats ▾ then one collapsible section per origin
 *       channel (Slack, Telegram, WhatsApp, …)
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
  onReorderConversations,
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

  const pinnedApps = usePinnedAppsStore.use.pinnedApps();

  const isCollapsedRail = collapsed && variant === "rail";

  // --- Pinned section resize ---
  // The section list's one rule doubles as the Pinned section's resize
  // handle. During a drag the handle drives the bounded row list through
  // this ref (no per-frame React state); the released height persists per
  // assistant. Radix unmounts closed accordion content, so the ref only
  // reaches a node while Pinned is expanded.
  const pinnedListRef = useRef<HTMLDivElement | null>(null);
  const pinnedListMaxHeight = usePinnedSectionHeight(assistantId);
  const pinnedResizable =
    sidebar.sections.some((section) => section.type === "pinned") &&
    sidebar.effectiveOpenSections.includes("pinned");

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

  const overlayBottomColumnRef = useRef<HTMLDivElement | null>(null);
  const [overlayBottomColumnHeight, setOverlayBottomColumnHeight] = useState(0);

  useLayoutEffect(() => {
    if (variant !== "overlay") {
      setOverlayBottomColumnHeight(0);
      return;
    }

    const el = overlayBottomColumnRef.current;
    if (!el) {
      return;
    }

    const updateHeight = () => {
      const nextHeight = Math.ceil(el.getBoundingClientRect().height);
      setOverlayBottomColumnHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [variant]);

  // --- Drag-reorder (Pinned + custom groups; sections sorted by displayOrder) ---

  const dragReorder = useDragReorder<Conversation>({
    getId: (c) => c.conversationId,
    onReorder: (_section, ordered) => onReorderConversations?.(ordered),
  });

  // Whole-section reordering, separate from the row-level controller above.
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
    dragReorder,
    canReorder: !!onReorderConversations,
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

  const renderSection = (section: SidebarSection) => (
    <SidebarSectionItem
      key={section.key}
      section={section}
      groupMenu={sectionMenu(section)}
      drag={sectionDragFor(section)}
      collapsedIndicator={collapsedActivityDot(section.all)}
      listRef={section.type === "pinned" ? pinnedListRef : undefined}
      listMaxHeight={
        section.type === "pinned" ? pinnedListMaxHeight : undefined
      }
    />
  );

  // --- Built-in navigation ---
  // Pinned apps above the built-in nav, separated by a divider. On the rail
  // this block lives in the non-scrolling header; on the overlay it renders
  // at the top of the body so the whole menu scrolls as one surface (Figma
  // 6764:6745).

  const builtInNav = (
    <>
      {pinnedApps.length > 0 ? (
        <>
          <div className="flex flex-col gap-[4px]">
            {pinnedApps.map((app) => (
              <PinnedAppNavItem
                key={app.appId}
                app={app}
                collapsed={collapsed}
                active={activeAppId === app.appId}
                onOpen={
                  onOpenApp
                    ? (appId) => {
                        onOpenApp(appId);
                        onClose?.();
                      }
                    : undefined
                }
              />
            ))}
          </div>
          <SideMenu.Separator />
        </>
      ) : null}
      {/* The assistant cluster: the avatar-colored assistant row with the
          New Chat row (avatar-tinted, plus + label; icon-only tile on the
          collapsed rail) beneath it, so the identity leads and the action
          hangs off it. No divider when
          expanded; breathing room below instead. On the collapsed rail
          the separator provides the section break, so the margin drops
          and the header's own gap (8px) plus the separator's margin keeps
          the divider ~12px off the cluster (Figma 7257:135812). The
          overlay drawer skips the New Chat row — its floating New Chat
          pill already owns that action in the thumb zone. */}
      <div className={isCollapsedRail ? undefined : "mb-4"}>
        <AssistantNavItem
          assistantId={assistantId ?? null}
          label={assistantName || "Your Assistant"}
          active={isIntelligenceActive}
          collapsed={collapsed}
          onSelect={
            onOpenIntelligence
              ? () => {
                  onOpenIntelligence();
                  onClose?.();
                }
              : undefined
          }
          onNewConversation={
            variant === "rail" && onStartNewConversation
              ? () => {
                  onStartNewConversation();
                  onClose?.();
                }
              : undefined
          }
        />
      </div>
      {/* The collapsed rail separates the cluster from the group icons
          below it (Figma 7257:135826). */}
      {isCollapsedRail ? <SideMenu.Separator /> : null}
    </>
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
               (Figma 6788:6749). On the Capacitor iOS shell the row floats
               over the scrollport so list content travels beneath the bare
               glyphs; `pointer-events-none` keeps the empty span between the
               two buttons scrollable. */
            <div className="flex items-center justify-between gap-2 native-ios:pointer-events-none native-ios:absolute native-ios:inset-x-4 native-ios:top-4 native-ios:z-10">
              <Button
                variant="ghost"
                iconOnly={<X />}
                aria-label="Close navigation"
                className={`pointer-events-auto ${NATIVE_IOS_BARE_ICON_BUTTON}`}
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
                 inline padding below is applied. pt-14 on iOS clears the 40px
                 the floating icon row covers plus a 16px gap, so the first
                 row starts below the glyphs at rest. */
                `-mx-4 gap-4 px-4 pb-24 native-ios:pt-14 ${NATIVE_IOS_LIST_TOP_FADE}`
              : /* The collapsed rail tucks the group icons up under the
                 cluster separator (~12px to the first icon tile) so they
                 read as the next section, not a distant island. */
                isCollapsedRail
                ? "gap-4 pt-2"
                : /* The scrollport spans the full rail so its scrollbar rides
                     the outer edge instead of cutting through the content, and
                     takes over the horizontal inset the root would have given
                     it, so rows sit exactly where they did. No top inset: the
                     sticky view switch sits flush against the header, and any
                     padding here would be a gap it has to cancel. */
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
              that keeps it clear of the floating close and search glyphs. It
              lives here rather than on the scrollport because the sticky view
              switch sticks to the scrollport's content box: any padding there
              would park the switch that far down and open a strip above it
              for rows to scroll through. `gap-4` restates the body's own gap,
              which wrapping these into one flex item would otherwise drop. */}
          {variant === "overlay" ? (
            <div className="flex flex-col gap-4 pt-3 max-md:pt-4">
              {builtInNav}
            </div>
          ) : null}
          {isCollapsedRail ? (
            /* The rail shows the same sections in the same order, as icons.
               Nothing here is type-aware - order and labels come straight
               from `sidebar.sections`, so the rail can't drift from the
               expanded list the way two hand-maintained orders would. */
            <div className="flex flex-col items-center gap-2">
              {sidebar.sections.map((section) => (
                <CollapsedGroupIcon
                  key={section.key}
                  icon={sectionIcon(section)}
                  label={section.label}
                  disabled={section.all.length === 0}
                  indicatorState={getGroupIndicatorState(
                    section.all,
                    processingConversationIds,
                    attentionConversationIds,
                  )}
                >
                  {(close, scrollParent) => (
                    <CollapsedGroupFlyout
                      title={section.label}
                      conversations={section.all}
                      onClosePopover={close}
                      scrollParent={scrollParent}
                    />
                  )}
                </CollapsedGroupIcon>
              ))}
              {/* The flat list has no section of its own to draw, so the rail
                  gives it one icon - otherwise the All view's conversations
                  would be unreachable while collapsed. */}
              {sidebar.viewMode === "all" ? (
                <CollapsedGroupIcon
                  icon={RECENTS_SECTION_ICON}
                  label={RECENTS_SECTION_LABEL}
                  disabled={sidebar.flatList.length === 0}
                  indicatorState={getGroupIndicatorState(
                    sidebar.flatList,
                    processingConversationIds,
                    attentionConversationIds,
                  )}
                >
                  {(close, scrollParent) => (
                    <CollapsedGroupFlyout
                      title={RECENTS_SECTION_LABEL}
                      conversations={sidebar.flatList}
                      onClosePopover={close}
                      scrollParent={scrollParent}
                    />
                  )}
                </CollapsedGroupIcon>
              ) : null}
            </div>
          ) : (
            /* Right-clicking the list (including the empty space below the
               last section) creates a group, so the affordance covers the
               whole scrollport rather than any one section. */
            <>
              {/* The switch leads the whole list and stays put: it is the
                  sidebar's top-level choice, not a header on any one part of
                  it. It sits outside the list wrapper because a sticky element
                  only holds while its own containing block is on screen, and
                  the section list ends where the flat list begins. */}
              <SidebarViewModeToggle
                value={sidebar.viewMode}
                onChange={sidebar.onViewModeChange}
              />
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
                    identical in both views. No dividers *between* them, since
                    a custom group is a peer of Pinned rather than a different
                    class of thing. */}
                {sidebar.sections
                  .slice(0, sidebar.curatedSectionCount)
                  .map(renderSection)}
                {/* The list's one rule, marking where curation ends and the
                    conversations begin. Absent when nothing is curated yet, so
                    a fresh sidebar never opens on a stray line. It carries no
                    margin, sitting on the root's own gap, and doubles as the
                    Pinned section's resize handle while Pinned is expanded. */}
                {sidebar.curatedSectionCount > 0 ? (
                  <SidebarSectionResizeHandle
                    targetRef={pinnedListRef}
                    resizable={pinnedResizable}
                    onCommit={(height) =>
                      savePinnedSectionHeight(assistantId, height)
                    }
                    onReset={() => resetPinnedSectionHeight(assistantId)}
                  />
                ) : null}
                {sidebar.sections
                  .slice(sidebar.curatedSectionCount)
                  .map(renderSection)}
              </CollapsibleNavSection.Root>
              {/* The All view's remainder: one headerless list, scrolling
                  against the sidebar body it already fills. */}
              {sidebar.viewMode === "all" && bodyElement ? (
                <ConversationRowList
                  items={sidebar.flatList}
                  scrollParent={bodyElement}
                />
              ) : null}
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
          /* Overlay: the footer bar is replaced by floating action pills so
             the primary actions sit in the thumb zone without spending two
             fixed rows (Figma 6764:6745). `pointer-events-none` on the
             container keeps the list scrollable between/around the pills.
             The container offsets itself by the bottom safe-area inset
             because the overlay sheet runs full-bleed to the physical
             screen edge — this keeps the pills above the home indicator
             while letting their drop shadows fade out naturally instead of
             being clipped at a safe-area boundary. */
          <div
            ref={overlayBottomColumnRef}
            className="pointer-events-none absolute inset-x-4 z-10 flex flex-col gap-4"
            style={{
              bottom:
                "calc(1rem + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
            }}
          >
            {/* `empty:hidden` collapses the row when the tip card renders
               null, so the column gap adds no phantom spacing. */}
            {tipCard ? (
              <div className="pointer-events-auto empty:hidden">{tipCard}</div>
            ) : null}
            <div className="flex items-center justify-center gap-4">
              {footerAction ? (
                <div className="pointer-events-auto flex-1">{footerAction}</div>
              ) : null}
              {onStartNewConversation ? (
                <Button
                  variant="primary"
                  className="pointer-events-auto h-10 flex-1 rounded-full px-4 shadow-[var(--shadow-lg)]"
                  leftIcon={<SquarePen />}
                  onClick={() => {
                    onStartNewConversation();
                    onClose?.();
                  }}
                >
                  New Chat
                </Button>
              ) : null}
            </div>
          </div>
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
