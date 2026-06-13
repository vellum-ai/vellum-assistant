import {
    Brain,
    Clock,
    Hash,
    LayoutGrid,
    Pin,
    Rocket,
    Search,
    SquarePen,
    X,
} from "lucide-react";
import { useCallback, type ReactNode } from "react";

import { useCommandPaletteStore } from "@/stores/command-palette-store";

import { CollapsibleNavSection } from "@/components/collapsible-nav-section";
import { CollapsedGroupIcon, getGroupIndicatorState } from "@/domains/chat/components/collapsed-group-icon";
import {
    ConversationActionsMenu,
    renderConversationMenuItems,
    type ConversationMenuItemsProps,
} from "@/domains/chat/components/conversation-actions-menu";
import { GroupActionsMenu, renderGroupMenuItems } from "@/domains/chat/components/group-actions-menu";
import { ThreadPinToggle } from "@/domains/chat/components/thread-pin-toggle";
import { useDragReorder } from "@/domains/chat/hooks/use-drag-reorder";
import { SIDEBAR_CONVERSATION_LIMIT, useSidebarState, type PaginatedSection, type UseSidebarStateParams } from "@/domains/chat/use-sidebar-state";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { isConversationPinned } from "@/domains/chat/utils/group-conversations";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { Conversation } from "@/types/conversation-types";
import { canMarkRead, canMarkUnread } from "@/utils/conversation-predicates";
import {
    Button,
    ContextMenu,
    PanelItem,
    SideMenu,
} from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

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
   * drag-reordering — Recents and Slack stay recency-sorted.
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

function SearchButton({ onClose }: { onClose?: () => void }) {
  const toggle = useCommandPaletteStore.use.toggle();
  const handleClick = useCallback(() => {
    onClose?.();
    toggle();
  }, [onClose, toggle]);
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
 *     • Slack ▾        — collapsible category when Slack conversations exist
 *   Footer
 *     • ───────────────
 *     • caller-provided action (PreferencesMenu)
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

  const buildDragProps = (
    section: string | undefined,
    items: Conversation[],
    conversation: Conversation,
  ) => {
    if (!section || !onReorderConversations || items.length < 2) return {};
    const { draggingId, dropIndicator } = dragReorder;
    const edge =
      dropIndicator?.section === section &&
      dropIndicator.itemId === conversation.conversationId
        ? dropIndicator.edge
        : null;
    return {
      ...dragReorder.getItemProps(section, items, conversation),
      className: cn(
        draggingId === conversation.conversationId && "opacity-50",
        edge === "before" && "shadow-[inset_0_2px_0_0_var(--primary-base)]",
        edge === "after" && "shadow-[inset_0_-2px_0_0_var(--primary-base)]",
      ),
    };
  };

  // --- Render helpers (action wiring, context menu, pin toggle) ---

  const renderThreadPinToggle = (conversation: Conversation): ReactNode => {
    const isProcessing =
      conversation.conversationId === activeConversationId
        ? activeConversationProcessing ?? false
        : processingConversationIds?.has(conversation.conversationId) ?? false;
    const needsAttention = attentionConversationIds?.has(conversation.conversationId) ?? false;
    return (
      <ThreadPinToggle
        conversation={conversation}
        isProcessing={isProcessing}
        needsAttention={needsAttention}
        onPinToggle={
          onPinConversation ? () => onPinConversation(conversation) : undefined
        }
      />
    );
  };

  const buildConversationMenuProps = (
    conversation: Conversation,
  ): ConversationMenuItemsProps => {
    const isChannel = isChannelConversation(conversation);
    return {
      isPinned: isConversationPinned(conversation),
      isArchived: conversation.archivedAt != null,
      isReadonly: isChannel,
      onPinToggle: onPinConversation
        ? () => onPinConversation(conversation)
        : undefined,
      onRename: onRenameConversation
        ? () => onRenameConversation(conversation)
        : undefined,
      onArchive: onArchiveConversation
        ? () => onArchiveConversation(conversation)
        : undefined,
      onUnarchive: onUnarchiveConversation
        ? () => onUnarchiveConversation(conversation)
        : undefined,
      onMarkRead:
        onMarkConversationRead && canMarkRead(conversation)
          ? () => onMarkConversationRead(conversation)
          : undefined,
      onMarkUnread:
        onMarkConversationUnread && !canMarkRead(conversation)
          ? () => onMarkConversationUnread(conversation)
          : undefined,
      isMarkUnreadDisabled: !canMarkUnread(conversation),
      onAnalyze:
        onAnalyze && conversation.conversationId != null && !isChannel
          ? () => onAnalyze(conversation)
          : undefined,
      onOpenInNewWindow:
        onOpenInNewWindow && conversation.conversationId != null
          ? () => onOpenInNewWindow(conversation)
          : undefined,
      onShareFeedback,
      onInspect:
        onInspect && conversation.conversationId != null
          ? () => onInspect(conversation)
          : undefined,
    };
  };

  const renderThreadActions = (conversation: Conversation): ReactNode => (
    <ConversationActionsMenu {...buildConversationMenuProps(conversation)} />
  );

  const renderThreadRow = (
    conversation: Conversation,
    panelItem: ReactNode,
  ): ReactNode => {
    const menuProps = buildConversationMenuProps(conversation);
    return (
      <ContextMenu.Root key={conversation.conversationId}>
        <ContextMenu.Trigger>{panelItem}</ContextMenu.Trigger>
        <ContextMenu.Content
          onClick={(event) => event.stopPropagation()}
        >
          {renderConversationMenuItems({ Primitive: ContextMenu, ...menuProps })}
        </ContextMenu.Content>
      </ContextMenu.Root>
    );
  };

  const buildGroupContextMenu = (
    groupName: string,
    conversations: Conversation[],
    options?: { onRename?: () => void; onDelete?: () => void },
  ) => {
    const hasAnyAction =
      onMarkAllReadInGroup || onArchiveAllInGroup || options?.onRename || options?.onDelete;
    if (!hasAnyAction) return undefined;

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
      onClick={() => {
        onStartNewConversation();
        onClose?.();
      }}
    />
  ) : null;

  // --- Flat conversation list renderer ---

  const renderFlatList = (
    items: Conversation[],
    pagination?: Pick<
      PaginatedSection,
      "showMore" | "onShowMore" | "showLess" | "onShowLess"
    >,
    reorderSection?: string,
  ): ReactNode => (
    <SideMenu.SubList>
      {items.map((c) =>
        renderThreadRow(
          c,
          <PanelItem
            leadingSlot={renderThreadPinToggle(c)}
            label={c.title ?? "Untitled"}
            marqueeOnHover
            active={c.conversationId === activeConversationId}
            onSelect={() => selectAndClose(c.conversationId)}
            trailingAction={renderThreadActions(c)}
            {...buildDragProps(reorderSection, items, c)}
          />,
        ),
      )}
      {pagination?.showMore ? (
        <SideMenu.Item
          label="Show more"
          size="compact"
          indent
          emphasized
          onSelect={pagination.onShowMore}
        />
      ) : null}
      {pagination?.showLess ? (
        <SideMenu.Item
          label="Show less"
          size="compact"
          indent
          emphasized
          onSelect={pagination.onShowLess}
        />
      ) : null}
    </SideMenu.SubList>
  );

  // --- Collapsed-rail popover content renderer ---

  const renderCollapsedGroupContent = (title: string, conversations: Conversation[], closePopover?: () => void, emptyState?: ReactNode): ReactNode => (
    <div className="pb-1">
      <div className="flex items-center justify-between px-4 py-1">
        <span className="text-body-small-default text-[var(--content-tertiary)]">{title}</span>
      </div>
      <div className="px-2">
        {conversations.length === 0 ? emptyState : null}
        {conversations.map((c) => (
          <PanelItem
            key={c.conversationId}
            leadingSlot={renderThreadPinToggle(c)}
            label={c.title ?? "Untitled"}
            active={c.conversationId === activeConversationId}
            onSelect={() => { closePopover?.(); selectAndClose(c.conversationId); }}
            trailingAction={renderThreadActions(c)}
          />
        ))}
      </div>
    </div>
  );

  // --- JSX ---

  return (
    <SideMenu
      ariaLabel="Assistant navigation"
      collapsed={collapsed}
      variant={variant}
      width={width}
      onWidthChange={onWidthChange}
      className="h-full"
    >
      <SideMenu.Header>
        {variant === "overlay" ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                iconOnly={<X />}
                aria-label="Close navigation"
                onClick={() => onClose?.()}
              />
              <SearchButton onClose={onClose} />
            </div>
            <div className="flex items-center gap-2">{headerActions}</div>
          </div>
        ) : null}
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
        {pinnedApps.map((app) => (
          <SideMenu.Item
            key={app.appId}
            // Apps source their icon as an emoji string on the manifest
            // (`app.icon`). Fall back to the Rocket lucide glyph so unmojified
            // apps still get a leading icon in the rail.
            icon={app.icon ?? Rocket}
            label={app.name}
            showCollapsedTooltip
            active={activeAppId === app.appId}
            onSelect={onOpenApp ? () => { onOpenApp(app.appId); onClose?.(); } : undefined}
          />
        ))}
        <SideMenu.Separator />
      </SideMenu.Header>

      <SideMenu.Body className="gap-1 pt-3 max-md:pt-4">
        {collapsed && variant === "rail" ? (
          <div className="flex flex-col items-center gap-1">
            {headerActions}
            {sidebar.pinned.length > 0 ? (
              <CollapsedGroupIcon
                icon={Pin}
                label="Pinned"
                indicatorState={getGroupIndicatorState(sidebar.pinned, processingConversationIds, attentionConversationIds)}
              >
                {(close) => renderCollapsedGroupContent("Pinned", sidebar.pinned, close)}
              </CollapsedGroupIcon>
            ) : null}
            <CollapsedGroupIcon
              icon={Clock}
              label="Recents"
              disabled={sidebar.recents.all.length === 0}
              indicatorState={getGroupIndicatorState(sidebar.recents.all, processingConversationIds, attentionConversationIds)}
            >
              {(close) => renderCollapsedGroupContent("Recents", sidebar.recents.all, close)}
            </CollapsedGroupIcon>
            <CollapsedGroupIcon
              icon={Hash}
              label="Slack"
              disabled={sidebar.slack.totalCount === 0}
              indicatorState={getGroupIndicatorState(sidebar.slack.all, processingConversationIds, attentionConversationIds)}
            >
              {(close) => renderCollapsedGroupContent("Slack", sidebar.slack.all, close)}
            </CollapsedGroupIcon>
          </div>
        ) : (
          <>
            {sidebar.pinned.length > 0 ? (
              <SideMenu.Section title="Pinned">
                {renderFlatList(sidebar.pinned, undefined, "pinned")}
              </SideMenu.Section>
            ) : null}

            <SideMenu.Section
              title="Conversations"
              className="gap-1"
              actions={variant === "overlay" ? undefined : headerActions}
            >
              {renderFlatList(sidebar.recents.items, sidebar.recents)}

              <CollapsibleNavSection.Root
                type="multiple"
                className="gap-1"
                value={sidebar.effectiveOpenCategories}
                onValueChange={sidebar.onOpenCategoriesChange}
              >
                {sidebar.slack.totalCount > 0 ? (
                  <CollapsibleNavSection.Section
                    value="slack"
                    icon={Hash}
                    label="Slack"
                    contextMenuContent={buildGroupContextMenu("Slack", sidebar.slack.all)}
                  >
                    {renderFlatList(sidebar.slack.items, sidebar.slack)}
                  </CollapsibleNavSection.Section>
                ) : null}
              </CollapsibleNavSection.Root>

              {sidebar.conversationGroupsEnabled && sidebar.customGroups.length > 0 ? (
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
                        <CollapsibleNavSection.Section
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
                        >
                          <SideMenu.SubList>
                            {group.conversations.map((c) =>
                              renderThreadRow(
                                c,
                                <PanelItem
                                  leadingSlot={renderThreadPinToggle(c)}
                                  label={c.title ?? "Untitled"}
                                  marqueeOnHover
                                  active={c.conversationId === activeConversationId}
                                  onSelect={() => selectAndClose(c.conversationId)}
                                  trailingAction={renderThreadActions(c)}
                                  {...buildDragProps(
                                    `group:${group.id}`,
                                    group.conversations,
                                    c,
                                  )}
                                />,
                              ),
                            )}
                          </SideMenu.SubList>
                        </CollapsibleNavSection.Section>
                      ))}
                    </CollapsibleNavSection.Root>
                  </SideMenu.Section>
                </>
              ) : null}
            </SideMenu.Section>
          </>
        )}
      </SideMenu.Body>

      {footerAction ? (
        <SideMenu.Footer>
          <SideMenu.Separator />
          {footerAction}
        </SideMenu.Footer>
      ) : null}
    </SideMenu>
  );
}
