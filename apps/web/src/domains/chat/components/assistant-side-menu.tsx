import {
  Brain,
  Calendar,
  CircleAlert,
  Clock,
  FolderPlus,
  Globe,
  Hash,
  LayoutGrid,
  Layers,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, startTransition, type ReactNode } from "react";

import {
  groupBackgroundConversationsBySource,
} from "@/domains/chat/utils/backgroundSubGroups.js";
import {
  groupScheduledConversationsByJobId,
} from "@/domains/chat/utils/scheduledSubGroups.js";
import {
  loadOpenCategories,
  loadOpenCustomGroups,
  saveOpenCategories,
  saveOpenCustomGroups,
} from "@/domains/chat/utils/sidebarGroupCollapseStorage.js";
import type { SubGroup } from "@/domains/chat/utils/subGroupUtils.js";
import { CollapsedConversationsButton } from "@/domains/chat/components/collapsed-conversations-button.js";
import {
  ConversationActionsMenu,
  renderConversationMenuItems,
  type ConversationMenuItemsProps,
} from "@/domains/chat/components/conversation-actions-menu.js";
import {
  BottomSheet,
  Button,
  cn,
  ContextMenu,
  PanelItem,
  Popover,
  SideMenu,
} from "@vellum/design-library";
import { CollapsibleNavSection } from "@/components/collapsible-nav-section.js";
import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { usePinnedAppsOptional } from "@/domains/chat/lib/pinnedAppsContext.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/app.js";

import { buildMoveToGroupTargets, groupConversations, isConversationPinned } from "@/domains/chat/utils/groupConversations.js";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel.js";
import { canMarkRead, canMarkUnread, type Conversation, type ConversationGroup } from "@/domains/chat/api/conversations.js";

/**
 * Maximum number of conversation entries rendered under expanded Slack and
 * Recents rows before a "Show more" affordance appears.
 */
export const ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT = 5;

export interface AssistantSideMenuProps {
  assistantId: string;
  assistantName?: string | null;
  collapsed: boolean;
  variant: "rail" | "overlay";
  conversations: Conversation[];
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
  conversationGroups?: ConversationGroup[];
  onCreateGroup?: () => void;
  onMoveToGroup?: (conversation: Conversation, groupId: string) => void;
  onRemoveFromGroup?: (conversation: Conversation) => void;
  onRenameGroup?: (groupId: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  processingConversationKeys?: Set<string>;
  attentionConversationKeys?: Set<string>;
  activeConversationProcessing?: boolean;
  onAnalyze?: (conversation: Conversation) => void;
  onOpenInNewWindow?: (conversation: Conversation) => void;
  onShareFeedback?: () => void;
  onInspect?: (conversation: Conversation) => void;
}

// ---------------------------------------------------------------------------
// countBadge — shared count-badge renderer (used by multiple sub-components)
// ---------------------------------------------------------------------------

function countBadge(n: number): ReactNode {
  return n > 0 ? (
    <span className="text-label-small-default inline-flex items-center justify-center rounded-[4px] bg-[var(--surface-base)] px-[4px] py-[2px] text-[var(--content-tertiary)]">
      {n}
    </span>
  ) : null;
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
 *
 * Every rendered thread row carries:
 *   - A Pin icon when `isPinned === true`.
 *   - A hover-revealed `ConversationActionsMenu` (Pin / Rename / Archive /
 *     Mark as unread). Action handlers are passed in as props — each one
 *     is optional, and when omitted its menu item is skipped entirely.
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
  onCreateGroup,
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
  const { conversationGroupsUI } = useAppFeatureFlags();

  const { pinned, scheduled, background, slack, recents, customGroups } =
    groupConversations(conversations, {
      groups: conversationGroups,
      customGroupsEnabled: conversationGroupsUI,
    });

  const pinnedApps = usePinnedAppsOptional()?.pinnedApps ?? [];

  const [showAllRecents, setShowAllRecents] = useState(false);
  const hasAttentionBeyondLimit = !showAllRecents
    && recents.length > ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT
    && attentionConversationKeys
    && recents.slice(ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT).some(c => attentionConversationKeys.has(c.conversationKey));
  const effectiveShowAll = showAllRecents || !!hasAttentionBeyondLimit;
  const recentsToShow = effectiveShowAll
    ? recents
    : recents.slice(0, ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT);
  const showMoreVisible =
    !effectiveShowAll && recents.length > ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT;
  const [showAllSlack, setShowAllSlack] = useState(false);
  const hasSlackAttentionBeyondLimit = !showAllSlack
    && slack.length > ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT
    && attentionConversationKeys
    && slack.slice(ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT).some(c => attentionConversationKeys.has(c.conversationKey));
  const effectiveShowAllSlack = showAllSlack || !!hasSlackAttentionBeyondLimit;
  const slackToShow = effectiveShowAllSlack
    ? slack
    : slack.slice(0, ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT);
  const showMoreSlackVisible =
    !effectiveShowAllSlack && slack.length > ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT;

  // Category accordion state lives here (lifted out of the
  // CollapsibleNavSection.Root uncontrolled default) so it survives
  // the rail's collapsed → expanded transition.
  const [openCategories, setOpenCategories] = useState<string[]>(["recents"]);

  // Custom groups use a SEPARATE state (and separate localStorage key) so
  // their CollapsibleNavSection.Root's onValueChange doesn't clobber the
  // built-in sections' state.
  const [openCustomGroups, setOpenCustomGroups] = useState<string[]>([]);

  useEffect(() => {
    if (assistantId) {
      startTransition(() => {
        setOpenCategories(loadOpenCategories(assistantId));
        setOpenCustomGroups(loadOpenCustomGroups(assistantId));
      });
    }
  }, [assistantId]);

  const handleOpenCategoriesChange = useCallback(
    (next: string[]) => {
      setOpenCategories(next);
      saveOpenCategories(assistantId, next);
    },
    [assistantId],
  );

  const handleOpenCustomGroupsChange = useCallback(
    (next: string[]) => {
      setOpenCustomGroups(next);
      saveOpenCustomGroups(assistantId, next);
    },
    [assistantId],
  );

  const hasAttentionIn = useCallback(
    (convs: Conversation[]) =>
      attentionConversationKeys ? convs.some(c => attentionConversationKeys.has(c.conversationKey)) : false,
    [attentionConversationKeys],
  );

  const effectiveOpenCategories = useMemo(() => {
    if (!attentionConversationKeys || attentionConversationKeys.size === 0) return openCategories;
    const extra: string[] = [];
    if (pinned.length > 0 && hasAttentionIn(pinned)) extra.push("pinned");
    if (scheduled.length > 0 && hasAttentionIn(scheduled)) extra.push("scheduled");
    if (background.length > 0 && hasAttentionIn(background)) extra.push("background");
    if (slack.length > 0 && hasAttentionIn(slack)) extra.push("slack");
    if (recents.length > 0 && hasAttentionIn(recents)) extra.push("recents");
    if (extra.length === 0) return openCategories;
    if (extra.every(c => openCategories.includes(c))) return openCategories;
    return [...new Set([...openCategories, ...extra])];
  }, [openCategories, attentionConversationKeys, pinned, scheduled, background, slack, recents, hasAttentionIn]);

  const effectiveOpenCustomGroups = useMemo(() => {
    if (!attentionConversationKeys || attentionConversationKeys.size === 0 || !customGroups) return openCustomGroups;
    const extra: string[] = [];
    for (const group of customGroups) {
      if (hasAttentionIn(group.conversations)) extra.push(group.id);
    }
    if (extra.length === 0) return openCustomGroups;
    if (extra.every(id => openCustomGroups.includes(id))) return openCustomGroups;
    return [...new Set([...openCustomGroups, ...extra])];
  }, [openCustomGroups, attentionConversationKeys, customGroups, hasAttentionIn]);

  const renderThreadPinToggle = (conversation: Conversation): ReactNode => {
    const isProcessing =
      conversation.conversationKey === activeConversationKey
        ? activeConversationProcessing ?? false
        : processingConversationKeys?.has(conversation.conversationKey) ?? false;
    const needsAttention = attentionConversationKeys?.has(conversation.conversationKey) ?? false;
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
        conversationGroupsUI && onMoveToGroup
          ? buildMoveToGroupTargets(conversation, conversationGroups)
          : undefined,
      onMoveToGroup:
        conversationGroupsUI && onMoveToGroup
          ? (groupId) => onMoveToGroup(conversation, groupId)
          : undefined,
      onRemoveFromGroup:
        conversationGroupsUI && onRemoveFromGroup && inCustomGroup
          ? () => onRemoveFromGroup(conversation)
          : undefined,
      onAnalyze:
        onAnalyze && conversation.conversationKey != null && !isChannel
          ? () => onAnalyze(conversation)
          : undefined,
      onOpenInNewWindow:
        onOpenInNewWindow && conversation.conversationKey != null
          ? () => onOpenInNewWindow(conversation)
          : undefined,
      onShareFeedback,
      onInspect:
        onInspect && conversation.conversationKey != null
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
      <ContextMenu.Root key={conversation.conversationKey}>
        <ContextMenu.Trigger>{panelItem}</ContextMenu.Trigger>
        <ContextMenu.Content
          onClick={(event) => event.stopPropagation()}
        >
          {renderConversationMenuItems({ Primitive: ContextMenu, ...menuProps })}
        </ContextMenu.Content>
      </ContextMenu.Root>
    );
  };

  const headerActions = (
    <>
      {conversationGroupsUI ? (
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<FolderPlus />}
          aria-label="Create group"
          onClick={onCreateGroup}
        />
      ) : null}
      <Button
        variant="ghost"
        size="compact"
        iconOnly={<SquarePen />}
        aria-label="New conversation"
        onClick={onStartNewConversation ? () => { onStartNewConversation(); onClose?.(); } : undefined}
      />
    </>
  );

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
              pinned={pinned}
              scheduled={scheduled}
              background={background}
              slack={slack}
              recents={recents}
              customGroups={conversationGroupsUI ? customGroups : undefined}
              activeConversationKey={activeConversationKey}
              onSelectConversation={(key) => { onSelectConversation(key); onClose?.(); }}
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
              value={effectiveOpenCategories}
              onValueChange={handleOpenCategoriesChange}
            >
              <CollapsibleNavSection.Section
                value="pinned"
                icon={Pin}
                label="Pinned"
                trailing={countBadge(pinned.length)}
              >
                <SideMenu.SubList>
                  {pinned.map((c) =>
                    renderThreadRow(
                      c,
                      <PanelItem
                        leadingSlot={renderThreadPinToggle(c)}
                        label={c.title ?? "Untitled"}
                        marqueeOnHover
                        active={c.conversationKey === activeConversationKey}
                        onSelect={() => { onSelectConversation(c.conversationKey); onClose?.(); }}
                        trailingAction={renderThreadActions(c)}
                      />,
                    ),
                  )}
                </SideMenu.SubList>
              </CollapsibleNavSection.Section>

              <CollapsibleNavSection.Section
                value="scheduled"
                icon={Calendar}
                label="Scheduled"
                trailing={countBadge(scheduled.length)}
              >
                <ScheduledSubGroups
                  conversations={scheduled}
                  activeConversationKey={activeConversationKey}
                  attentionConversationKeys={attentionConversationKeys}
                  onSelectConversation={(key) => { onSelectConversation(key); onClose?.(); }}
                  renderActions={renderThreadActions}
                  renderPinToggle={renderThreadPinToggle}
                  renderRow={renderThreadRow}
                />
              </CollapsibleNavSection.Section>

              <CollapsibleNavSection.Section
                value="background"
                icon={Layers}
                label="Background"
                trailing={countBadge(background.length)}
              >
                <BackgroundSubGroups
                  conversations={background}
                  activeConversationKey={activeConversationKey}
                  attentionConversationKeys={attentionConversationKeys}
                  onSelectConversation={(key) => { onSelectConversation(key); onClose?.(); }}
                  renderActions={renderThreadActions}
                  renderPinToggle={renderThreadPinToggle}
                  renderRow={renderThreadRow}
                />
              </CollapsibleNavSection.Section>

              {slack.length > 0 ? (
                <CollapsibleNavSection.Section
                  value="slack"
                  icon={Hash}
                  label="Slack"
                  trailing={countBadge(slack.length)}
                >
                  <SideMenu.SubList>
                    {slackToShow.map((c) =>
                      renderThreadRow(
                        c,
                        <PanelItem
                          leadingSlot={renderThreadPinToggle(c)}
                          label={c.title ?? "Untitled"}
                          marqueeOnHover
                          active={c.conversationKey === activeConversationKey}
                          onSelect={() => { onSelectConversation(c.conversationKey); onClose?.(); }}
                          trailingAction={renderThreadActions(c)}
                        />,
                      ),
                    )}
                    {showMoreSlackVisible ? (
                      <SideMenu.Item
                        label="Show more"
                        size="compact"
                        indent
                        emphasized
                        onSelect={() => setShowAllSlack(true)}
                      />
                    ) : null}
                  </SideMenu.SubList>
                </CollapsibleNavSection.Section>
              ) : null}

              <CollapsibleNavSection.Section
                value="recents"
                icon={Clock}
                label="Recents"
                trailing={countBadge(recents.length)}
              >
                <SideMenu.SubList>
                  {recentsToShow.map((c) =>
                    renderThreadRow(
                      c,
                      <PanelItem
                        leadingSlot={renderThreadPinToggle(c)}
                        label={c.title ?? "Untitled"}
                        marqueeOnHover
                        active={c.conversationKey === activeConversationKey}
                        onSelect={() => { onSelectConversation(c.conversationKey); onClose?.(); }}
                        trailingAction={renderThreadActions(c)}
                      />,
                    ),
                  )}
                  {showMoreVisible ? (
                    <SideMenu.Item
                      label="Show more"
                      size="compact"
                      indent
                      emphasized
                      onSelect={() => setShowAllRecents(true)}
                    />
                  ) : null}
                </SideMenu.SubList>
              </CollapsibleNavSection.Section>
            </CollapsibleNavSection.Root>

            {conversationGroupsUI && customGroups.length > 0 ? (
              <>
                <SideMenu.Separator />
                <SideMenu.Section title="Your Groups">
                  <CollapsibleNavSection.Root
                    type="multiple"
                    value={effectiveOpenCustomGroups}
                    onValueChange={handleOpenCustomGroupsChange}
                  >
                    {customGroups.map((group) => (
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
                                active={
                                  c.conversationKey === activeConversationKey
                                }
                                onSelect={() => { onSelectConversation(c.conversationKey); onClose?.(); }}
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


// ---------------------------------------------------------------------------
// SubGroupAccordion — shared sub-accordion for Background + Scheduled
// ---------------------------------------------------------------------------

interface SubGroupAccordionProps {
  subGroups: SubGroup[];
  isSingleRow: (group: SubGroup) => boolean;
  activeConversationKey?: string;
  attentionConversationKeys?: Set<string>;
  onSelectConversation: (key: string) => void;
  renderActions: (conversation: Conversation) => ReactNode;
  renderPinToggle: (conversation: Conversation) => ReactNode;
  renderRow: (conversation: Conversation, panelItem: ReactNode) => ReactNode;
}

function SubGroupAccordion({
  subGroups,
  isSingleRow,
  activeConversationKey,
  attentionConversationKeys,
  onSelectConversation,
  renderActions,
  renderPinToggle,
  renderRow,
}: SubGroupAccordionProps) {
  return (
    <div className="flex flex-col gap-2">
      {subGroups.map((group) => {
        if (isSingleRow(group)) {
          const c = group.conversations[0];
          if (!c) return null;
          return renderRow(
            c,
            <PanelItem
              leadingSlot={renderPinToggle(c)}
              label={c.title ?? "Untitled"}
              marqueeOnHover
              active={c.conversationKey === activeConversationKey}
              onSelect={() => onSelectConversation(c.conversationKey)}
              trailingAction={renderActions(c)}
            />,
          );
        }
        const groupHasAttention = attentionConversationKeys
          ? group.conversations.some(c => attentionConversationKeys.has(c.conversationKey))
          : false;
        return (
          <CollapsibleNavSection.Root
            key={group.key}
            type="multiple"
            className="gap-0"
            {...(groupHasAttention ? { value: [group.key] } : {})}
          >
            <CollapsibleNavSection.Section
              value={group.key}
              label={group.label}
              trailing={countBadge(group.conversations.length)}
            >
              <SideMenu.SubList>
                {group.conversations.map((c) =>
                  renderRow(
                    c,
                    <PanelItem
                      leadingSlot={renderPinToggle(c)}
                      label={c.title ?? "Untitled"}
                      marqueeOnHover
                      active={c.conversationKey === activeConversationKey}
                      onSelect={() => onSelectConversation(c.conversationKey)}
                      trailingAction={renderActions(c)}
                    />,
                  ),
                )}
              </SideMenu.SubList>
            </CollapsibleNavSection.Section>
          </CollapsibleNavSection.Root>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BackgroundSubGroups / ScheduledSubGroups — thin wrappers over SubGroupAccordion
// ---------------------------------------------------------------------------

interface CategorySubGroupsProps {
  conversations: Conversation[];
  activeConversationKey?: string;
  attentionConversationKeys?: Set<string>;
  onSelectConversation: (key: string) => void;
  renderActions: (conversation: Conversation) => ReactNode;
  renderPinToggle: (conversation: Conversation) => ReactNode;
  renderRow: (conversation: Conversation, panelItem: ReactNode) => ReactNode;
}

function BackgroundSubGroups(props: CategorySubGroupsProps) {
  return (
    <SubGroupAccordion
      subGroups={groupBackgroundConversationsBySource(props.conversations)}
      isSingleRow={(g) => g.key.startsWith("__single__:")}
      activeConversationKey={props.activeConversationKey}
      attentionConversationKeys={props.attentionConversationKeys}
      onSelectConversation={props.onSelectConversation}
      renderActions={props.renderActions}
      renderPinToggle={props.renderPinToggle}
      renderRow={props.renderRow}
    />
  );
}

function ScheduledSubGroups(props: CategorySubGroupsProps) {
  return (
    <SubGroupAccordion
      subGroups={groupScheduledConversationsByJobId(props.conversations)}
      isSingleRow={(g) => g.conversations.length === 1}
      activeConversationKey={props.activeConversationKey}
      attentionConversationKeys={props.attentionConversationKeys}
      onSelectConversation={props.onSelectConversation}
      renderActions={props.renderActions}
      renderPinToggle={props.renderPinToggle}
      renderRow={props.renderRow}
    />
  );
}

// ---------------------------------------------------------------------------
// ThreadPinToggle — leading pin icon for thread rows
// ---------------------------------------------------------------------------

interface ThreadPinToggleProps {
  conversation: Conversation;
  onPinToggle?: () => void;
  isProcessing?: boolean;
  needsAttention?: boolean;
}

const SLOT_BASE = cn(
  "relative inline-flex size-[14px] shrink-0 items-center justify-center",
  "text-[var(--content-tertiary)]",
);

const HOVER_REVEAL =
  "absolute inset-0 m-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100";

const IDLE_FADE = cn(
  "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
);

/**
 * Idle-state indicator that fades out on hover, paired with a pin/unpin
 * glyph that fades in. The two occupy the same slot via absolute positioning
 * so the swap is layout-shift-free.
 */
function IdleAndHoverGlyphs({
  idle,
  isPinned,
}: {
  idle: ReactNode;
  isPinned: boolean;
}) {
  const HoverIcon = isPinned ? PinOff : Pin;
  return (
    <>
      {idle}
      <HoverIcon size={14} aria-hidden className={HOVER_REVEAL} />
    </>
  );
}

/**
 * Leading-slot button for a thread row. State machine (priority order):
 *
 *   Needs attention   → Exclamation circle (warning color, no pulse).
 *   Processing + idle → Pulsing dot (animate-pulse, primary-base).
 *   Unread + idle     → Static dot (system-mid-strong).
 *   Pinned + idle     → Hidden (no glyph; PinOff appears on hover).
 *   Unpinned + idle   → Pin glyph at 0 opacity (hidden; label aligns).
 *   Any + hover       → Pin/PinOff toggle (overrides dot).
 *
 * Clicking fires `onPinToggle` with event propagation stopped so the
 * row's own `onSelect` doesn't also fire.
 */
function ThreadPinToggle({ conversation, onPinToggle, isProcessing, needsAttention }: ThreadPinToggleProps) {
  const isPinned = isConversationPinned(conversation);
  const showUnreadDot = conversation.hasUnseenLatestAssistantMessage === true;

  // --- Determine which idle indicator to show ---

  let glyphs: ReactNode;

  if (needsAttention) {
    glyphs = (
      <IdleAndHoverGlyphs
        isPinned={isPinned}
        idle={
          <CircleAlert
            size={14}
            aria-hidden
            className={cn("absolute inset-0 m-auto text-[var(--system-mid-strong)]", IDLE_FADE)}
          />
        }
      />
    );
  } else if (isProcessing) {
    glyphs = (
      <IdleAndHoverGlyphs
        isPinned={isPinned}
        idle={
          <span
            aria-hidden
            className={cn(
              "absolute inset-0 m-auto h-2 w-2 rounded-full bg-[var(--primary-base)] animate-pulse",
              IDLE_FADE,
            )}
          />
        }
      />
    );
  } else if (showUnreadDot) {
    glyphs = (
      <IdleAndHoverGlyphs
        isPinned={isPinned}
        idle={
          <span
            aria-hidden
            className={cn(
              "absolute inset-0 m-auto h-2 w-2 rounded-full bg-[var(--system-mid-strong)]",
              IDLE_FADE,
            )}
          />
        }
      />
    );
  } else if (isPinned) {
    glyphs = <PinOff size={14} aria-hidden className={HOVER_REVEAL} />;
  } else {
    glyphs = (
      <Pin
        size={14}
        aria-hidden
        className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      />
    );
  }

  // --- Wrap in interactive or non-interactive container ---

  if (!onPinToggle) {
    return (
      <span aria-hidden className={SLOT_BASE}>
        {glyphs}
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={isPinned ? "Unpin conversation" : "Pin conversation"}
      onClick={(event) => {
        event.stopPropagation();
        onPinToggle();
      }}
      className={cn(
        SLOT_BASE,
        "cursor-pointer hover:text-[var(--content-secondary)]",
        "rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
      )}
    >
      {glyphs}
    </button>
  );
}

// ---------------------------------------------------------------------------
// GroupActionsMenu — rename/delete context menu for custom group headers
// ---------------------------------------------------------------------------

interface GroupActionsMenuProps {
  groupId: string;
  onRename?: (groupId: string) => void;
  onDelete?: (groupId: string) => void;
}

export function GroupActionsMenu({ groupId, onRename, onDelete }: GroupActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const closeMenu = () => setOpen(false);

  const trigger = (
    <button
      type="button"
      aria-label="Group actions"
      aria-haspopup="menu"
      onClick={(event) => event.stopPropagation()}
      className="flex h-5 w-5 items-center justify-center rounded-[4px] text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)] aria-[expanded=true]:bg-[var(--surface-active)] aria-[expanded=true]:text-[var(--content-emphasised)]"
    >
      <MoreHorizontal size={14} aria-hidden />
    </button>
  );

  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
        <BottomSheet.Content>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>Group actions</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">
            {onRename ? (
              <PanelItem
                icon={Pencil}
                label="Rename"
                onSelect={() => {
                  closeMenu();
                  onRename(groupId);
                }}
              />
            ) : null}
            {onDelete ? (
              <PanelItem
                icon={Trash2}
                label="Delete"
                onSelect={() => {
                  closeMenu();
                  onDelete(groupId);
                }}
              />
            ) : null}
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Content
        side="right"
        align="start"
        sideOffset={4}
        className="w-40 rounded-lg py-2 px-0"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-2">
          {onRename ? (
            <PanelItem
              icon={Pencil}
              label="Rename"
              onSelect={() => {
                closeMenu();
                onRename(groupId);
              }}
            />
          ) : null}
          {onDelete ? (
            <PanelItem
              icon={Trash2}
              label="Delete"
              onSelect={() => {
                closeMenu();
                onDelete(groupId);
              }}
            />
          ) : null}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
