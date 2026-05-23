import {
  Brain,
  Calendar,
  Clock,
  Globe,
  Hash,
  Layers,
  LayoutGrid,
  Pin,
  Search,
  SquarePen,
  X,
} from "lucide-react";
import { useCallback, type ReactNode } from "react";

import {
  ConversationActionsMenu,
  renderConversationMenuItems,
  type ConversationMenuItemsProps,
} from "@/domains/chat/components/conversation-actions-menu.js";
import { CollapsedConversationsButton } from "@/domains/chat/components/collapsed-conversations-button.js";
import { ThreadPinToggle } from "@/domains/chat/components/thread-pin-toggle.js";
import { GroupActionsMenu } from "@/domains/chat/components/group-actions-menu.js";
import { BackgroundSubGroups, ScheduledSubGroups } from "@/domains/chat/components/sub-group-accordion.js";
import { countBadge } from "@/domains/chat/components/sidebar-count-badge.js";
import { useSidebarState, SIDEBAR_CONVERSATION_LIMIT, type UseSidebarStateParams } from "@/domains/chat/use-sidebar-state.js";
import {
  Button,
  ContextMenu,
  PanelItem,
  SideMenu,
} from "@vellum/design-library";
import { CollapsibleNavSection } from "@/components/collapsible-nav-section.js";
import { usePinnedAppsStore } from "@/domains/chat/pinned-apps-store.js";
import { buildMoveToGroupTargets, isConversationPinned } from "@/domains/chat/utils/group-conversations.js";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel.js";
import { canMarkRead, canMarkUnread, type Conversation } from "@/domains/chat/api/conversations.js";

/** @deprecated Use {@link SIDEBAR_CONVERSATION_LIMIT} from `use-sidebar-state.ts` */
export const ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT = SIDEBAR_CONVERSATION_LIMIT;

export interface AssistantSideMenuProps extends UseSidebarStateParams {
  assistantName?: string | null;
  collapsed: boolean;
  variant: "rail" | "overlay";
  activeConversationKey?: string;
  onSelectConversation: (key: string) => void;
  isIntelligenceActive?: boolean;
  onOpenIntelligence?: () => void;
  isLibraryActive?: boolean;
  onOpenLibrary?: () => void;
  onOpenApp?: (appId: string) => void;
  activeAppId?: string;
  onStartNewConversation?: () => void;
  footerBanner?: ReactNode;
  footerAction?: ReactNode;
  onClose?: () => void;
  onSearchClick?: () => void;
  onPinConversation?: (conversation: Conversation) => void;
  onRenameConversation?: (conversation: Conversation) => void;
  onArchiveConversation?: (conversation: Conversation) => void;
  onUnarchiveConversation?: (conversation: Conversation) => void;
  onMarkConversationUnread?: (conversation: Conversation) => void;
  onMarkConversationRead?: (conversation: Conversation) => void;
  onMoveToGroup?: (conversation: Conversation, groupId: string) => void;
  onRemoveFromGroup?: (conversation: Conversation) => void;
  onRenameGroup?: (groupId: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  processingConversationKeys?: Set<string>;
  activeConversationProcessing?: boolean;
  onAnalyze?: (conversation: Conversation) => void;
  onOpenInNewWindow?: (conversation: Conversation) => void;
  onShareFeedback?: () => void;
  onInspect?: (conversation: Conversation) => void;
}

/**
 * Assistant sidebar content.
 *
 * Structure (top → bottom):
 *
 *   Header
 *     • Your Assistant → Intelligence view
 *     • ───────────────
 *   Body · Conversations section
 *     • Pinned (count)         — category summary
 *     • Scheduled (count)      — category summary
 *     • Background (count)     — category summary (includes Reflections sub-group)
 *     • Slack (count) ▾        — expanded inline when Slack conversations exist
 *     • Recents (count) ▾      — expanded inline
 *         ◦ thread … (pin icon if pinned, hover reveals …)
 *         ◦ …
 *         ◦ Show more (if > limit)
 *   Footer
 *     • ───────────────
 *     • caller-provided action (PreferencesMenu)
 */
export function AssistantSideMenu({
  assistantId,
  assistantName,
  collapsed,
  variant,
  conversations,
  activeConversationKey,
  onSelectConversation,
  isIntelligenceActive = false,
  onOpenIntelligence,
  isLibraryActive = false,
  onOpenLibrary,
  onOpenApp,
  activeAppId,
  onStartNewConversation,
  footerBanner,
  footerAction,
  onPinConversation,
  onRenameConversation,
  onArchiveConversation,
  onUnarchiveConversation,
  onMarkConversationUnread,
  onMarkConversationRead,
  conversationGroups,
  onMoveToGroup,
  onRemoveFromGroup,
  onRenameGroup,
  onDeleteGroup,
  onClose,
  onSearchClick,
  processingConversationKeys,
  attentionConversationKeys,
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
    attentionConversationKeys,
  });

  const pinnedApps = usePinnedAppsStore.use.pinnedApps();

  // --- Render helpers (action wiring, context menu, pin toggle) ---

  const renderThreadPinToggle = (conversation: Conversation): ReactNode => {
    const isProcessing =
      conversation.conversationId === activeConversationKey
        ? activeConversationProcessing ?? false
        : processingConversationKeys?.has(conversation.conversationId) ?? false;
    const needsAttention = attentionConversationKeys?.has(conversation.conversationId) ?? false;
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
    const inCustomGroup =
      !!conversation.groupId && !conversation.groupId.startsWith("system:");
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
      moveToGroups:
        sidebar.conversationGroupsEnabled && onMoveToGroup
          ? buildMoveToGroupTargets(conversation, conversationGroups)
          : undefined,
      onMoveToGroup:
        sidebar.conversationGroupsEnabled && onMoveToGroup
          ? (groupId) => onMoveToGroup(conversation, groupId)
          : undefined,
      onRemoveFromGroup:
        sidebar.conversationGroupsEnabled && onRemoveFromGroup && inCustomGroup
          ? () => onRemoveFromGroup(conversation)
          : undefined,
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

  // --- Shared sub-component props ---

  const subGroupProps = {
    activeConversationKey,
    attentionConversationKeys,
    onSelectConversation: useCallback(
      (key: string) => { onSelectConversation(key); onClose?.(); },
      [onSelectConversation, onClose],
    ),
    renderActions: renderThreadActions,
    renderPinToggle: renderThreadPinToggle,
    renderRow: renderThreadRow,
  };

  const selectAndClose = useCallback(
    (key: string) => { onSelectConversation(key); onClose?.(); },
    [onSelectConversation, onClose],
  );

  // --- Header actions ---

  const headerActions = onStartNewConversation ? (
    <Button
      variant="ghost"
      size="compact"
      iconOnly={<SquarePen />}
      aria-label="New conversation"
      onClick={() => { onStartNewConversation(); onClose?.(); }}
    />
  ) : null;

  // --- Flat conversation list renderer ---

  const renderFlatList = (
    items: Conversation[],
    showMore: boolean,
    onShowMore: () => void,
  ): ReactNode => (
    <SideMenu.SubList>
      {items.map((c) =>
        renderThreadRow(
          c,
          <PanelItem
            leadingSlot={renderThreadPinToggle(c)}
            label={c.title ?? "Untitled"}
            marqueeOnHover
            active={c.conversationId === activeConversationKey}
            onSelect={() => selectAndClose(c.conversationId)}
            trailingAction={renderThreadActions(c)}
          />,
        ),
      )}
      {showMore ? (
        <SideMenu.Item
          label="Show more"
          size="compact"
          indent
          emphasized
          onSelect={onShowMore}
        />
      ) : null}
    </SideMenu.SubList>
  );

  // --- JSX ---

  return (
    <SideMenu
      ariaLabel="Assistant navigation"
      collapsed={collapsed}
      variant={variant}
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
              {onSearchClick ? (
                <Button
                  variant="ghost"
                  iconOnly={<Search />}
                  aria-label="Search (⌘K)"
                  title="Search (⌘K)"
                  onClick={() => {
                    onClose?.();
                    onSearchClick();
                  }}
                />
              ) : null}
            </div>
            <div className="flex items-center gap-2">{headerActions}</div>
          </div>
        ) : null}
        <SideMenu.Item
          icon={Brain}
          label={assistantName || "Your Assistant"}
          active={isIntelligenceActive}
          onSelect={onOpenIntelligence ? () => { onOpenIntelligence(); onClose?.(); } : undefined}
        />
        {onOpenLibrary ? (
          <SideMenu.Item
            icon={LayoutGrid}
            label="Library"
            active={isLibraryActive}
            onSelect={onOpenLibrary ? () => { onOpenLibrary(); onClose?.(); } : undefined}
          />
        ) : null}
        {pinnedApps.map((app) => (
          <SideMenu.Item
            key={app.appId}
            icon={Globe}
            label={app.name}
            active={activeAppId === app.appId}
            onSelect={onOpenApp ? () => { onOpenApp(app.appId); onClose?.(); } : undefined}
          />
        ))}
        <SideMenu.Separator />
      </SideMenu.Header>

      <SideMenu.Body className="pt-3 max-md:pt-4">
        {collapsed && variant === "rail" ? (
          <div className="flex flex-col items-center gap-1">
            {headerActions}
            <CollapsedConversationsButton
              pinned={sidebar.pinned}
              scheduled={sidebar.scheduled}
              background={sidebar.background}
              slack={sidebar.slack.all}
              recents={sidebar.recents.all}
              customGroups={sidebar.conversationGroupsEnabled ? sidebar.customGroups : undefined}
              activeConversationKey={activeConversationKey}
              onSelectConversation={selectAndClose}
              renderActions={renderThreadActions}
              attentionConversationKeys={attentionConversationKeys}
            />
          </div>
        ) : (
          <SideMenu.Section
            title="Conversations"
            actions={variant === "overlay" ? undefined : headerActions}
          >
            <CollapsibleNavSection.Root
              type="multiple"
              value={sidebar.effectiveOpenCategories}
              onValueChange={sidebar.onOpenCategoriesChange}
            >
              <CollapsibleNavSection.Section
                value="pinned"
                icon={Pin}
                label="Pinned"
                trailing={countBadge(sidebar.pinned.length)}
              >
                {renderFlatList(sidebar.pinned, false, () => {})}
              </CollapsibleNavSection.Section>

              <CollapsibleNavSection.Section
                value="recents"
                icon={Clock}
                label="Recents"
                trailing={countBadge(sidebar.recents.totalCount)}
              >
                {renderFlatList(sidebar.recents.items, sidebar.recents.showMore, sidebar.recents.onShowMore)}
              </CollapsibleNavSection.Section>

              <CollapsibleNavSection.Section
                value="scheduled"
                icon={Calendar}
                label="Scheduled"
                trailing={countBadge(sidebar.scheduled.length)}
              >
                <ScheduledSubGroups
                  subGroups={sidebar.scheduledSubGroups}
                  {...subGroupProps}
                />
              </CollapsibleNavSection.Section>

              <CollapsibleNavSection.Section
                value="background"
                icon={Layers}
                label="Background"
                trailing={countBadge(sidebar.background.length)}
              >
                <BackgroundSubGroups
                  subGroups={sidebar.backgroundSubGroups}
                  {...subGroupProps}
                />
              </CollapsibleNavSection.Section>

              {sidebar.slack.totalCount > 0 ? (
                <CollapsibleNavSection.Section
                  value="slack"
                  icon={Hash}
                  label="Slack"
                  trailing={countBadge(sidebar.slack.totalCount)}
                >
                  {renderFlatList(sidebar.slack.items, sidebar.slack.showMore, sidebar.slack.onShowMore)}
                </CollapsibleNavSection.Section>
              ) : null}
            </CollapsibleNavSection.Root>

            {sidebar.conversationGroupsEnabled && sidebar.customGroups.length > 0 ? (
              <>
                <SideMenu.Separator />
                <SideMenu.Section title="Your Groups">
                  <CollapsibleNavSection.Root
                    type="multiple"
                    value={sidebar.effectiveOpenCustomGroups}
                    onValueChange={sidebar.onOpenCustomGroupsChange}
                  >
                    {sidebar.customGroups.map((group) => (
                      <CollapsibleNavSection.Section
                        key={group.id}
                        value={group.id}
                        label={group.name}
                        trailing={
                          <span className="flex items-center gap-1">
                            {countBadge(group.conversations.length)}
                            {onRenameGroup || onDeleteGroup ? (
                              <GroupActionsMenu
                                groupId={group.id}
                                onRename={onRenameGroup}
                                onDelete={onDeleteGroup}
                              />
                            ) : null}
                          </span>
                        }
                      >
                        <SideMenu.SubList>
                          {group.conversations.map((c) =>
                            renderThreadRow(
                              c,
                              <PanelItem
                                leadingSlot={renderThreadPinToggle(c)}
                                label={c.title ?? "Untitled"}
                                marqueeOnHover
                                active={c.conversationId === activeConversationKey}
                                onSelect={() => selectAndClose(c.conversationId)}
                                trailingAction={renderThreadActions(c)}
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
        )}
      </SideMenu.Body>

      {(footerBanner || footerAction) ? (
        <SideMenu.Footer>
          {collapsed ? null : footerBanner}
          <SideMenu.Separator />
          {footerAction}
        </SideMenu.Footer>
      ) : null}
    </SideMenu>
  );
}
