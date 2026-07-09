import {
    Brain,
    Calendar,
    Clock,
    LayoutGrid,
    Pin,
    Search,
    SquarePen,
    X,
} from "lucide-react";
import { useCallback, type ReactNode } from "react";

import { useCommandPaletteStore } from "@/stores/command-palette-store";

import { CollapsibleNavSection } from "@/components/collapsible-nav-section";
import { CollapsedGroupIcon, getGroupIndicatorState } from "@/domains/chat/components/collapsed-group-icon";
import {
    ConversationListProvider,
    type ConversationListContextValue,
} from "@/domains/chat/components/conversation-list-context";
import {
    ConversationNavSection,
    ConversationRowList,
} from "@/domains/chat/components/conversation-nav-section";
import { CollapsedGroupFlyout } from "@/domains/chat/components/conversation-rail-flyout";
import { GroupActionsMenu, renderGroupMenuItems } from "@/domains/chat/components/group-actions-menu";
import { PinnedAppNavItem } from "@/domains/chat/components/pinned-app-nav-item";
import { useDragReorder } from "@/domains/chat/hooks/use-drag-reorder";
import { SIDEBAR_CONVERSATION_LIMIT, useSidebarState, type UseSidebarStateParams } from "@/domains/chat/use-sidebar-state";
import { channelSectionKey } from "@/domains/chat/utils/sidebar-group-collapse-storage";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { Conversation } from "@/types/conversation-types";
import { getChannelIcon, getChannelLabel } from "@/utils/channel-presentation";
import {
    Button,
    ContextMenu,
    SideMenu,
} from "@vellumai/design-library";

/** @deprecated Use {@link SIDEBAR_CONVERSATION_LIMIT} from `use-sidebar-state.ts` */
export const ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT = SIDEBAR_CONVERSATION_LIMIT;

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
  isLibraryActive?: boolean;
  onOpenLibrary?: () => void;
  isHomeActive?: boolean;
  onOpenHome?: () => void;
  hasUnreadHome?: boolean;
  onOpenApp?: (appId: string) => void;
  activeAppId?: string;
  onStartNewConversation?: () => void;
  footerAction?: ReactNode;
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
  onRenameGroup?: (groupId: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  onMarkAllReadInGroup?: (conversations: Conversation[]) => void;
  onArchiveAllInGroup?: (groupName: string, conversations: Conversation[]) => void;
  processingConversationIds?: Set<string>;
  activeConversationProcessing?: boolean;
  onAnalyze?: (conversation: Conversation) => void;
  onOpenInNewWindow?: (conversation: Conversation) => void;
  onShareFeedback?: () => void;
  onInspect?: (conversation: Conversation) => void;
}

function SearchButton() {
  const toggle = useCommandPaletteStore.use.toggle();
  // Intentionally does NOT close the drawer. On mobile the command palette
  // renders full-screen at z-50 (see command-palette.tsx), painting above the
  // navigation drawer (fixed z-40 in chat-layout) so it fully covers the menu
  // while open. Leaving the drawer mounted underneath means dismissing the
  // palette (✕ / Escape / backdrop) returns to the menu the user opened search
  // from, instead of falling through to the chat view (Figma 6788:6749).
  const handleClick = useCallback(() => {
    toggle();
  }, [toggle]);
  return (
    <Button
      variant="ghost"
      iconOnly={<Search />}
      aria-label="Search (⌘K)"
      title="Search (⌘K)"
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
 *     • Your Assistant → Intelligence view
 *     • ───────────────
 *   Body · Pinned section (when non-empty)
 *     • pinned thread
 *   Body · Conversations section
 *     • thread …       — recent conversations inline
 *     • …
 *     • Show more/less — page through recent conversations
 *     • Channel ▾      — one collapsible section per origin channel
 *                        (Slack, Telegram, WhatsApp, …)
 *   Footer
 *     • ───────────────
 *     • caller-provided action (PreferencesMenu)
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
  isLibraryActive = false,
  onOpenLibrary,
  isHomeActive = false,
  onOpenHome,
  hasUnreadHome = false,
  onOpenApp,
  activeAppId,
  onStartNewConversation,
  footerAction,
  onPinConversation,
  onReorderConversations,
  onRenameConversation,
  onArchiveConversation,
  onUnarchiveConversation,
  onMarkConversationUnread,
  onMarkConversationRead,
  conversationGroups,
  onRenameGroup,
  onDeleteGroup,
  onMarkAllReadInGroup,
  onArchiveAllInGroup,
  onClose,
  processingConversationIds,
  attentionConversationIds,
  activeConversationProcessing,
  onAnalyze,
  onOpenInNewWindow,
  onShareFeedback,
  onInspect,
}: AssistantSideMenuProps) {
  const sidebar = useSidebarState({
    assistantId,
    conversations,
    conversationGroups,
    attentionConversationIds,
  });

  const pinnedApps = usePinnedAppsStore.use.pinnedApps();

  // --- Drag-reorder (Pinned + custom groups; sections sorted by displayOrder) ---

  const dragReorder = useDragReorder<Conversation>({
    getId: (c) => c.conversationId,
    onReorder: (_section, ordered) => onReorderConversations?.(ordered),
  });

  // Context menu content for a section header (channel section / custom
  // group). Returns undefined when no group-level action is available.
  const buildGroupContextMenu = (
    groupName: string,
    conversations: Conversation[],
    options?: { onRename?: () => void; onDelete?: () => void },
  ) => {
    const hasAnyAction =
      onMarkAllReadInGroup || onArchiveAllInGroup || options?.onRename || options?.onDelete;
    if (!hasAnyAction) {
      return undefined;
    }

    return renderGroupMenuItems({
      Primitive: ContextMenu,
      onMarkAllRead: onMarkAllReadInGroup
        ? () => onMarkAllReadInGroup(conversations)
        : undefined,
      hasUnreadConversations: conversations.some(
        (c) => c.hasUnseenLatestAssistantMessage,
      ),
      onArchiveAll: onArchiveAllInGroup
        ? () => onArchiveAllInGroup(groupName, conversations)
        : undefined,
      hasConversations: conversations.length > 0,
      onRename: options?.onRename,
      onDelete: options?.onDelete,
    });
  };

  const selectAndClose = useCallback(
    (key: string) => { onSelectConversation(key); onClose?.(); },
    [onSelectConversation, onClose],
  );

  // Shared context for every conversation row (Pinned, Recents, channel
  // sections, custom groups, rail flyout): the action callbacks,
  // active/processing/attention state, and drag controller the rows read.
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
    onAnalyze,
    onOpenInNewWindow,
    onShareFeedback,
    onInspect,
    dragReorder,
    canReorder: !!onReorderConversations,
  };

  // --- Header actions ---
  // A plain icon button that starts a new conversation on click.

  const headerActions = onStartNewConversation ? (
    <Button
      variant="ghost"
      size="compact"
      iconOnly={<SquarePen />}
      aria-label="New conversation"
      tooltip="New conversation"
      tooltipSide="right"
      className="text-[var(--content-tertiary)]"
      onClick={() => {
        onStartNewConversation();
        onClose?.();
      }}
    />
  ) : null;

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
                onOpen={onOpenApp ? (appId) => { onOpenApp(appId); onClose?.(); } : undefined}
              />
            ))}
          </div>
          <SideMenu.Separator />
        </>
      ) : null}
      {/* 4px row gap to match the conversation list. */}
      <div className="flex flex-col gap-[4px]">
        <SideMenu.Item
          icon={Brain}
          label={assistantName || "Your Assistant"}
          showCollapsedTooltip
          active={isIntelligenceActive}
          onSelect={onOpenIntelligence ? () => { onOpenIntelligence(); onClose?.(); } : undefined}
        />
        {onOpenLibrary ? (
          <SideMenu.Item
            icon={LayoutGrid}
            label="Library"
            showCollapsedTooltip
            active={isLibraryActive}
            onSelect={onOpenLibrary ? () => { onOpenLibrary(); onClose?.(); } : undefined}
          />
        ) : null}
        {onOpenHome ? (
          <SideMenu.Item
            icon={Calendar}
            label="Activity"
            showCollapsedTooltip
            active={isHomeActive}
            badge={
              hasUnreadHome && !isHomeActive ? (
                <span
                  className="h-2 w-2 rounded-full bg-[var(--system-negative-strong)]"
                  aria-hidden="true"
                />
              ) : undefined
            }
            onSelect={onOpenHome ? () => { onOpenHome(); onClose?.(); } : undefined}
          />
        ) : null}
      </div>
      <SideMenu.Separator />
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
        className="relative h-full"
      >
        <SideMenu.Header>
          {variant === "overlay" ? (
            /* Close on the left, Search pinned to the right so it stays put
               and always reads as the persistent search affordance
               (Figma 6788:6749). */
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                iconOnly={<X />}
                aria-label="Close navigation"
                onClick={() => onClose?.()}
              />
              <SearchButton />
            </div>
          ) : (
            builtInNav
          )}
        </SideMenu.Header>

        <SideMenu.Body
          className={
            variant === "overlay"
              /* pb-24 keeps the last rows scrollable clear of the floating
                 action pills. */
              ? "gap-4 pt-3 pb-24 max-md:pt-4"
              : "gap-4 pt-3 max-md:pt-4"
          }
        >
          {variant === "overlay" ? builtInNav : null}
          {collapsed && variant === "rail" ? (
            <div className="flex flex-col items-center gap-2">
              {headerActions}
              {sidebar.pinned.length > 0 ? (
                <CollapsedGroupIcon
                  icon={Pin}
                  label="Pinned"
                  indicatorState={getGroupIndicatorState(sidebar.pinned, processingConversationIds, attentionConversationIds)}
                >
                  {(close) => (
                    <CollapsedGroupFlyout
                      title="Pinned"
                      conversations={sidebar.pinned}
                      onClosePopover={close}
                    />
                  )}
                </CollapsedGroupIcon>
              ) : null}
              <CollapsedGroupIcon
                icon={Clock}
                label="Recents"
                disabled={sidebar.recents.all.length === 0}
                indicatorState={getGroupIndicatorState(sidebar.recents.all, processingConversationIds, attentionConversationIds)}
              >
                {(close) => (
                  <CollapsedGroupFlyout
                    title="Recents"
                    conversations={sidebar.recents.all}
                    onClosePopover={close}
                  />
                )}
              </CollapsedGroupIcon>
              {sidebar.channelSections.map((section) => (
                <CollapsedGroupIcon
                  key={section.channelId}
                  icon={getChannelIcon(section.channelId)}
                  label={getChannelLabel(section.channelId)}
                  disabled={section.totalCount === 0}
                  indicatorState={getGroupIndicatorState(section.all, processingConversationIds, attentionConversationIds)}
                >
                  {(close) => (
                    <CollapsedGroupFlyout
                      title={getChannelLabel(section.channelId)}
                      conversations={section.all}
                      onClosePopover={close}
                    />
                  )}
                </CollapsedGroupIcon>
              ))}
            </div>
          ) : (
            <>
              {sidebar.pinned.length > 0 ? (
                <SideMenu.Section title="Pinned" className="gap-1">
                  <ConversationRowList items={sidebar.pinned} dragSection="pinned" />
                </SideMenu.Section>
              ) : null}

              <SideMenu.Section
                title="Conversations"
                className="gap-1"
                actions={variant === "overlay" ? undefined : headerActions}
              >
                <ConversationRowList
                  items={sidebar.recents.items}
                  pagination={sidebar.recents}
                />

                <CollapsibleNavSection.Root
                  type="multiple"
                  className="gap-1"
                  value={sidebar.effectiveOpenCategories}
                  onValueChange={sidebar.onOpenCategoriesChange}
                >
                  {sidebar.channelSections.map((section) => {
                    const label = getChannelLabel(section.channelId);
                    return (
                      <ConversationNavSection
                        key={section.channelId}
                        value={channelSectionKey(section.channelId)}
                        icon={getChannelIcon(section.channelId)}
                        label={label}
                        contextMenuContent={buildGroupContextMenu(label, section.all)}
                        items={section.items}
                        pagination={section}
                      />
                    );
                  })}
                </CollapsibleNavSection.Root>

                {sidebar.customGroups.length > 0 ? (
                  <>
                    <SideMenu.Separator />
                    <SideMenu.Section title="Your Groups">
                      <CollapsibleNavSection.Root
                        type="multiple"
                        className="gap-1"
                        value={sidebar.effectiveOpenCustomGroups}
                        onValueChange={sidebar.onOpenCustomGroupsChange}
                      >
                        {sidebar.customGroups.map((group) => (
                          <ConversationNavSection
                            key={group.id}
                            value={group.id}
                            label={group.name}
                            trailing={
                              onRenameGroup || onDeleteGroup ? (
                                <GroupActionsMenu
                                  groupId={group.id}
                                  onRename={onRenameGroup}
                                  onDelete={onDeleteGroup}
                                />
                              ) : null
                            }
                            contextMenuContent={buildGroupContextMenu(
                              group.name,
                              group.conversations,
                              {
                                onRename: onRenameGroup
                                  ? () => onRenameGroup(group.id)
                                  : undefined,
                                onDelete: onDeleteGroup
                                  ? () => onDeleteGroup(group.id)
                                  : undefined,
                              },
                            )}
                            items={group.conversations}
                            dragSection={`group:${group.id}`}
                          />
                        ))}
                      </CollapsibleNavSection.Root>
                    </SideMenu.Section>
                  </>
                ) : null}
              </SideMenu.Section>
            </>
          )}
        </SideMenu.Body>

        {variant === "overlay" ? (
          /* Overlay: the footer bar is replaced by floating action pills so
             the primary actions sit in the thumb zone without spending two
             fixed rows (Figma 6764:6745). `pointer-events-none` on the row
             keeps the list scrollable between/around the pills. */
          <div className="pointer-events-none absolute inset-x-4 bottom-4 z-10 flex items-center justify-center gap-4">
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
        ) : footerAction ? (
          <SideMenu.Footer>
            {/* The collapsed rail drops the footer divider (per design). */}
            {collapsed && variant === "rail" ? null : <SideMenu.Separator />}
            {footerAction}
          </SideMenu.Footer>
        ) : null}
      </SideMenu>
    </ConversationListProvider>
  );
}
