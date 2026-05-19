
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
} from "@/domains/chat/lib/backgroundSubGroups.js";
import {
  groupScheduledConversationsByJobId,
} from "@/domains/chat/lib/scheduledSubGroups.js";
import {
  loadOpenCategories,
  loadOpenCustomGroups,
  saveOpenCategories,
  saveOpenCustomGroups,
} from "@/domains/chat/lib/sidebarGroupCollapseStorage.js";
import type { SubGroup } from "@/domains/chat/lib/subGroupUtils.js";
import { CollapsedConversationsButton } from "@/components/app/assistant/CollapsedConversationsButton/CollapsedConversationsButton.js";
import {
  ConversationActionsMenu,
  renderConversationMenuItems,
  type ConversationMenuItemsProps,
} from "@/components/app/assistant/ConversationActionsMenu/ConversationActionsMenu.js";
import { BottomSheet } from "@vellum/design-library/components/bottom-sheet";
import { Button } from "@vellum/design-library/components/button";
import { CollapsibleNavSection } from "@/components/app/core/CollapsibleNavSection/CollapsibleNavSection.js";
import { ContextMenu } from "@vellum/design-library/components/context-menu";
import { PanelItem } from "@/components/app/core/PanelItem/PanelItem.js";
import { Popover } from "@vellum/design-library/components/popover";
import { SideMenu } from "@/components/app/core/SideMenu/SideMenu.js";
import { useIsMobile } from "@/lib/hooks/useIsMobile.js";
import { usePinnedAppsOptional } from "@/domains/chat/lib/pinnedAppsContext.js";
import { cn } from "@vellum/design-library/utils/cn";
import {
  canMarkRead,
  canMarkUnread,
  type Conversation,
  type ConversationGroup,
} from "@/domains/chat/lib/api.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/feature-flag-provider.js";

import { buildMoveToGroupTargets, groupConversations, isConversationPinned } from "@/domains/chat/lib/groupConversations.js";
import { isChannelConversation } from "@/domains/chat/lib/conversation-channel.js";

/**
 * Maximum number of conversation entries rendered under expanded Slack and
 * Recents rows before a "Show more" affordance appears.
 */
export const ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT = 5;

export interface AssistantSideMenuProps {
  /** Unused today — reserved for assistant-scoped routing on nav rows. */
  assistantId: string;
  /** Display name for the assistant, resolved from the runtime identity. */
  assistantName?: string | null;
  /** Whether the rail is in its collapsed state. */
  collapsed: boolean;
  /** `"rail"` on desktop, `"overlay"` on mobile. */
  variant: "rail" | "overlay";
  conversations: Conversation[];
  /** `conversationKey` of the currently-selected thread. */
  activeConversationKey?: string;
  onSelectConversation: (key: string) => void;
  /** Whether the main pane is currently showing the Intelligence view. */
  isIntelligenceActive?: boolean;
  /** Opens the Intelligence view in the main pane. */
  onOpenIntelligence?: () => void;
  /** Whether the main pane is currently showing the Library view. */
  isLibraryActive?: boolean;
  /** Opens the Library view in the main pane. */
  onOpenLibrary?: () => void;
  /** Called when the user clicks a pinned app to open it. */
  onOpenApp?: (appId: string) => void;
  /** The appId of the currently-active app, if any. */
  activeAppId?: string;
  /** Start a new (empty) conversation. Wired to the compose button. */
  onStartNewConversation?: () => void;
  /** Content rendered above the footer separator (e.g. a promotional card). */
  footerBanner?: ReactNode;
  /** Footer content (typically `<PreferencesMenu />`)). Omit to hide the footer. */
  footerAction?: ReactNode;
  /** Called when a nav action occurs in overlay/mobile mode so the drawer closes. */
  onClose?: () => void;
  /** Open the command palette. Only used by the overlay variant — the rail
   *  doesn't render a search affordance (the shell header owns that on desktop). */
  onSearchClick?: () => void;
  /** Toggle pinned state of a conversation (no backend endpoint yet — stub OK). */
  onPinConversation?: (conversation: Conversation) => void;
  /** Rename a conversation (needs a rename modal — stub OK for now). */
  onRenameConversation?: (conversation: Conversation) => void;
  /** Archive a conversation. */
  onArchiveConversation?: (conversation: Conversation) => void;
  /** Unarchive a conversation. */
  onUnarchiveConversation?: (conversation: Conversation) => void;
  /** Mark the latest assistant message as unread. */
  onMarkConversationUnread?: (conversation: Conversation) => void;
  onMarkConversationRead?: (conversation: Conversation) => void;
  /** Known conversation groups (fetched from the backend). */
  conversationGroups?: ConversationGroup[];
  /** Callback for the "Create Group" button. No-op stub is fine for now. */
  onCreateGroup?: () => void;
  /** Move a conversation to the specified group. */
  onMoveToGroup?: (conversation: Conversation, groupId: string) => void;
  /**
   * Remove a conversation from its current (non-system) group, falling
   * back to Recents. Only wired on rows where the conversation belongs
   * to a non-system group; the menu hides the affordance otherwise.
   */
  onRemoveFromGroup?: (conversation: Conversation) => void;
  /** Rename a custom group by id. */
  onRenameGroup?: (groupId: string) => void;
  /** Delete a custom group by id. Conversations fall back to Recents. */
  onDeleteGroup?: (groupId: string) => void;
  /** Set of conversation keys currently being processed (assistant thinking/streaming). */
  processingConversationKeys?: Set<string>;
  /** Set of conversation keys that need user attention (pending approval/secret). */
  attentionConversationKeys?: Set<string>;
  /** Whether the active conversation is currently processing. */
  activeConversationProcessing?: boolean;
  /** Analyze a conversation via the daemon. */
  onAnalyze?: (conversation: Conversation) => void;
  /** Open a conversation in a new browser tab. */
  onOpenInNewWindow?: (conversation: Conversation) => void;
  /** Open the Share Feedback modal. */
  onShareFeedback?: () => void;
  /**
   * Open the per-conversation LLM context inspector. Web counterpart of
   * macOS's per-bubble "Inspect LLM context" item — surfaced on the
   * conversation overflow menu instead, ungated.
   */
  onInspect?: (conversation: Conversation) => void;
}

// ---------------------------------------------------------------------------
// countBadge — shared count-badge renderer (used by multiple sub-components)
// ---------------------------------------------------------------------------

/**
 * Render a compact count badge for category/sub-group headers. Returns
 * `null` for zero counts so the row doesn't read as a misleading "0".
 */
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
  void assistantId;

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
  // `CollapsibleNavSection.Root` uncontrolled default) so it survives
  // the rail's collapsed → expanded transition. The collapsed-rail
  // branch unmounts the accordion subtree; uncontrolled state dies with
  // it, and re-expanding would reset every section to closed. Keeping
  // the array up here means the accordion re-mounts with the same
  // sections still open.
  //
  // Initialize with the default so SSR and the initial render always agree
  // (avoids hydration mismatch). A useEffect syncs from localStorage once
  // assistantId is available on the client, and re-syncs if the user
  // switches assistants while the component stays mounted.
  // Built-in sections (pinned / scheduled / background / slack / recents).
  // Initialised with the SSR-safe default; synced from localStorage once
  // assistantId is available on the client.
  const [openCategories, setOpenCategories] = useState<string[]>(["recents"]);

  // Custom groups use a SEPARATE state (and separate localStorage key) so
  // their CollapsibleNavSection.Root's onValueChange doesn't clobber the
  // built-in sections' state, and vice versa (Radix emits the full array
  // for items within that root only).
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

  /**
   * Build the leading slot for a thread row — a Pin icon that's
   * invisible by default, visible on row hover OR when the thread is
   * already pinned. Clicking it toggles pin state without triggering
   * the row's onSelect.
   */
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

  /**
   * Build the shared menu-item props for a conversation. Both the
   * dropdown ellipsis menu and the row's right-click context menu
   * consume this so they stay in lockstep — handlers omitted by the
   * parent simply hide the corresponding item.
   */
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

  /**
   * Trailing-action ellipsis dropdown for a thread row.
   */
  const renderThreadActions = (conversation: Conversation): ReactNode => (
    <ConversationActionsMenu {...buildConversationMenuProps(conversation)} />
  );

  /**
   * Wrap a thread-row `PanelItem` with a right-click context menu that
   * mirrors the ellipsis dropdown's items. Right-clicking the ellipsis
   * itself doesn't open this menu — the ellipsis trigger stops the
   * `contextmenu` event so its dropdown is the only surface.
   */
  const renderThreadRow = (
    conversation: Conversation,
    panelItem: ReactNode,
  ): ReactNode => {
    const menuProps = buildConversationMenuProps(conversation);
    return (
      <ContextMenu.Root key={conversation.conversationKey}>
        <ContextMenu.Trigger>{panelItem}</ContextMenu.Trigger>
        <ContextMenu.Content
          // React portal events bubble through the component tree, not the DOM tree.
          // Without this, clicking a menu item also triggers PanelItem's onSelect.
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
          // Overlay variant covers the entire viewport including the top
          // bar, so the affordances normally in the shell header live
          // here: close + search on the left, new-conversation /
          // create-group on the right.
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

      {/* `pt-3` (12px) keeps the Conversations title off the divider; mobile
          bumps to 16px for breathing room above the larger row text. */}
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
              // Controlled — state lives in AssistantSideMenu so it
              // survives the collapsed-rail transition (which unmounts
              // this subtree). See `openCategories` above.
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

            {/* Custom groups — visible only when the flag is on and
                at least one group exists. */}
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
  /**
   * Determine whether a sub-group should render as a flat (single-row)
   * conversation instead of a collapsible accordion section. Background
   * uses the `__single__:` key prefix; Scheduled flattens any group with
   * only one conversation.
   */
  isSingleRow: (group: SubGroup) => boolean;
  activeConversationKey?: string;
  attentionConversationKeys?: Set<string>;
  onSelectConversation: (key: string) => void;
  renderActions: (conversation: Conversation) => ReactNode;
  renderPinToggle: (conversation: Conversation) => ReactNode;
  /**
   * Wrap a thread-row `PanelItem` with a right-click context menu. The
   * caller provides this so the context-menu items match the dropdown's
   * items for the same conversation.
   */
  renderRow: (conversation: Conversation, panelItem: ReactNode) => ReactNode;
}

/**
 * Generic sub-accordion that renders a list of `SubGroup` entries.
 * Each multi-item group becomes a collapsible section; groups that
 * satisfy `isSingleRow` render as flat `PanelItem` rows.
 *
 * Insertion order is preserved so the caller can rely on the grouping
 * function's first-seen ordering for display.
 */
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

/**
 * Background sub-accordion. Conversations without a `source` get a
 * `__single__:` key and render as flat rows; all other groups collapse.
 */
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

/**
 * Scheduled sub-accordion. Single-conversation groups — whether jobless
 * (`__single__:` key) or a job with only one run so far — render as flat
 * rows; multi-conversation jobs get a collapsible section.
 */
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
 * row's own `onSelect` (switch to this conversation) doesn't also fire.
 * When no handler is supplied we render a non-interactive `<span>` with
 * the same layout so a missing wiring doesn't collapse the row's width.
 */
function ThreadPinToggle({ conversation, onPinToggle, isProcessing, needsAttention }: ThreadPinToggleProps) {
  const isPinned = isConversationPinned(conversation);
  const showUnreadDot = conversation.hasUnseenLatestAssistantMessage === true;

  // Visual swap uses a two-child overlay approach: the idle indicator
  // (dot or pin) hides on group-hover, and the pin toggle reveals.
  // Keeping both paths CSS-only means no mouseenter/leave state and no
  // flicker.
  const slotBase = cn(
    "relative inline-flex size-[14px] shrink-0 items-center justify-center",
    "text-[var(--content-tertiary)]",
  );

  // Attention indicator takes highest priority — static warning icon
  if (needsAttention) {
    const glyphs = (
      <>
        <CircleAlert
          size={14}
          aria-hidden
          className={cn(
            "absolute inset-0 m-auto text-[var(--system-mid-strong)]",
            "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
          )}
        />
        {isPinned ? (
          <PinOff
            size={14}
            aria-hidden
            className="absolute inset-0 m-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          />
        ) : (
          <Pin
            size={14}
            aria-hidden
            className="absolute inset-0 m-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          />
        )}
      </>
    );

    if (!onPinToggle) {
      return (
        <span aria-hidden className={slotBase}>
          {glyphs}
        </span>
      );
    }

    return (
      <span
        role="button"
        tabIndex={0}
        aria-label={isPinned ? "Unpin conversation" : "Pin conversation"}
        onClick={(event) => {
          event.stopPropagation();
          onPinToggle();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            onPinToggle();
          }
        }}
        className={cn(
          slotBase,
          "cursor-pointer hover:text-[var(--content-secondary)]",
          "rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        )}
      >
        {glyphs}
      </span>
    );
  }

  // Processing dot takes next priority — pulsing black dot
  if (isProcessing) {
    const glyphs = (
      <>
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 m-auto h-2 w-2 rounded-full bg-[var(--primary-base)] animate-pulse",
            "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
          )}
        />
        {isPinned ? (
          <PinOff
            size={14}
            aria-hidden
            className="absolute inset-0 m-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          />
        ) : (
          <Pin
            size={14}
            aria-hidden
            className="absolute inset-0 m-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          />
        )}
      </>
    );

    if (!onPinToggle) {
      return (
        <span aria-hidden className={slotBase}>
          {glyphs}
        </span>
      );
    }

    return (
      <span
        role="button"
        tabIndex={0}
        aria-label={isPinned ? "Unpin conversation" : "Pin conversation"}
        onClick={(event) => {
          event.stopPropagation();
          onPinToggle();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            onPinToggle();
          }
        }}
        className={cn(
          slotBase,
          "cursor-pointer hover:text-[var(--content-secondary)]",
          "rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        )}
      >
        {glyphs}
      </span>
    );
  }

  const pinnedGlyphs = (
    <PinOff
      size={14}
      aria-hidden
      className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
    />
  );

  // Unread dot occupies the same slot as the pin glyph; it fades out on
  // hover so the pin toggle (which fades in) replaces it without a
  // layout shift.
  const unpinnedGlyphs = showUnreadDot ? (
    <>
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 m-auto h-2 w-2 rounded-full bg-[var(--system-mid-strong)]",
          "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
        )}
      />
      <Pin
        size={14}
        aria-hidden
        className="absolute inset-0 m-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      />
    </>
  ) : (
    <Pin
      size={14}
      aria-hidden
      className={cn(
        "transition-opacity",
        "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
      )}
    />
  );

  // For pinned rows with unread dot: show the dot (not the pin) in idle,
  // and PinOff on hover.
  const glyphs = isPinned ? (showUnreadDot ? (
    <>
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 m-auto h-2 w-2 rounded-full bg-[var(--system-mid-strong)]",
          "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
        )}
      />
      <PinOff
        size={14}
        aria-hidden
        className="absolute inset-0 m-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      />
    </>
  ) : pinnedGlyphs) : unpinnedGlyphs;

  if (!onPinToggle) {
    return (
      <span aria-hidden className={slotBase}>
        {glyphs}
      </span>
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={isPinned ? "Unpin conversation" : "Pin conversation"}
      onClick={(event) => {
        event.stopPropagation();
        onPinToggle();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onPinToggle();
        }
      }}
      className={cn(
        slotBase,
        "cursor-pointer hover:text-[var(--content-secondary)]",
        "rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
      )}
    >
      {glyphs}
    </span>
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

/**
 * Ellipsis button in the trailing slot of a custom group header. Opens a
 * popover with Rename and Delete actions. Mirrors the pattern used by
 * `ConversationActionsMenu` for individual threads.
 */
export function GroupActionsMenu({ groupId, onRename, onDelete }: GroupActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const closeMenu = () => setOpen(false);

  // Trigger is shared across both branches — same accessibility props,
  // same hover/active styling. Defined once so the JSX below stays focused
  // on what differs between desktop and mobile (the menu surface).
  const trigger = (
    <span
      role="button"
      tabIndex={0}
      aria-label="Group actions"
      aria-haspopup="menu"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          (event.currentTarget as HTMLElement).click();
        }
      }}
      className="flex h-5 w-5 items-center justify-center rounded-[4px] text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)] aria-[expanded=true]:bg-[var(--surface-active)] aria-[expanded=true]:text-[var(--content-emphasised)]"
    >
      <MoreHorizontal size={14} aria-hidden />
    </span>
  );

  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
        <BottomSheet.Content>
          {/* Visually-hidden Title — Rename/Delete rows are self-describing. */}
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
