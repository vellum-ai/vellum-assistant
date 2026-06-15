/**
 * Data-shaping hook for the assistant sidebar.
 *
 * Owns conversation grouping, pagination ("show more"), collapse/expand
 * state, and attention-forced expansion. Returns a typed object the
 * presentational `AssistantSideMenu` renders without any inline
 * computation, `useEffect`, or derived state.
 *
 * Memoizes grouping per `conversations` reference so parent re-renders
 * that don't change the conversation list skip the grouping work.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 * @see {@link https://react.dev/reference/react/useMemo}
 */

import { useCallback, useEffect, useMemo, useState, startTransition } from "react";

import type { Conversation, ConversationGroup } from "@/types/conversation-types";
import { groupConversations, type CustomGroup } from "@/domains/chat/utils/group-conversations";
import { groupBackgroundConversationsBySource } from "@/domains/chat/utils/background-sub-groups";
import { groupScheduledConversationsByJobId } from "@/domains/chat/utils/scheduled-sub-groups";
import type { SubGroup } from "@/domains/chat/utils/sub-group";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useSidebarCollapseStore } from "@/domains/chat/sidebar-collapse-store";
import { mergeConversationLists } from "@/utils/conversation-cache";
import {
  useBackgroundConversationListQuery,
  useScheduledConversationListQuery,
} from "@/hooks/conversation-queries";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const SIDEBAR_CONVERSATION_LIMIT = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaginatedSection {
  /** All conversations in this group from loaded pages (not necessarily every
   * conversation that exists — further pages may contain more). */
  loaded: Conversation[];
  items: Conversation[];
  totalCount: number;
  showMore: boolean;
  showLess: boolean;
  onShowMore: () => void;
  onShowLess: () => void;
  /** Fires when the user scrolls to the bottom of the expanded list. */
  onScrollLoadMore?: () => void;
}

export interface SidebarState {
  pinned: Conversation[];

  scheduled: Conversation[];
  scheduledSubGroups: SubGroup[];

  background: Conversation[];
  backgroundSubGroups: SubGroup[];

  slack: PaginatedSection;
  recents: PaginatedSection;

  customGroups: CustomGroup[];

  effectiveOpenCategories: string[];
  effectiveOpenCustomGroups: string[];
  onOpenCategoriesChange: (next: string[]) => void;
  onOpenCustomGroupsChange: (next: string[]) => void;

  conversationGroupsEnabled: boolean;

  /**
   * Reveal the Background section, enabling its lazy fetch. Wired to the
   * collapsed rail's flyout trigger, which opens without going through
   * `onOpenCategoriesChange`.
   */
  activateBackground: () => void;
  /** True once the Background section is revealed but its fetch is still in flight. */
  backgroundLoading: boolean;
  /**
   * Reveal the Scheduled section, enabling its lazy fetch. Independent of
   * `activateBackground` so opening Scheduled never fetches the background
   * backlog.
   */
  activateScheduled: () => void;
  /** True once the Scheduled section is revealed but its fetch is still in flight. */
  scheduledLoading: boolean;
}

// ---------------------------------------------------------------------------
// Section factory
// ---------------------------------------------------------------------------

interface BuildPaginatedSectionParams {
  items: Conversation[];
  isExpanded: boolean;
  attentionConversationIds: Set<string> | undefined;
  hasNextPage: boolean | undefined;
  fetchNextPage: (() => void) | undefined;
  onExpand: () => void;
  onCollapse: () => void;
}

/**
 * Pure function that builds a `PaginatedSection` from grouped items and
 * expansion state. Extracted to DRY the identical logic that was duplicated
 * across Recents and Slack sections.
 */
function buildPaginatedSection({
  items,
  isExpanded,
  attentionConversationIds,
  hasNextPage,
  fetchNextPage,
  onExpand,
  onCollapse,
}: BuildPaginatedSectionParams): PaginatedSection {
  const attentionIndex = attentionConversationIds
    ? items.findIndex((c) => attentionConversationIds.has(c.conversationId))
    : -1;
  const visibleCount = isExpanded ? items.length : SIDEBAR_CONVERSATION_LIMIT;
  const effectiveVisibleCount =
    attentionIndex >= visibleCount ? attentionIndex + 1 : visibleCount;
  // Treat the section as effectively expanded when attention forces us past
  // the collapsed limit — otherwise the user sees many items with "Show more"
  // and no "Show less" (a broken state).
  const effectivelyExpanded =
    isExpanded || effectiveVisibleCount > SIDEBAR_CONVERSATION_LIMIT;
  const hasMoreItems =
    effectiveVisibleCount < items.length || (hasNextPage ?? false);
  return {
    loaded: items,
    items: items.slice(0, effectiveVisibleCount),
    totalCount: items.length,
    showMore: !effectivelyExpanded && hasMoreItems,
    showLess: effectivelyExpanded,
    onShowMore: () => {
      onExpand();
      if (hasNextPage) fetchNextPage?.();
    },
    onShowLess: onCollapse,
    onScrollLoadMore: effectivelyExpanded && hasNextPage ? fetchNextPage : undefined,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseSidebarStateParams {
  assistantId: string;
  conversations: Conversation[];
  conversationGroups?: ConversationGroup[];
  attentionConversationIds?: Set<string>;
  /** Trigger loading of the next page from the server. */
  fetchNextPage?: () => void;
  /** Whether the server has more pages to load. */
  hasNextPage?: boolean;
}

export function useSidebarState({
  assistantId,
  conversations,
  conversationGroups,
  attentionConversationIds,
  fetchNextPage,
  hasNextPage,
}: UseSidebarStateParams): SidebarState {
  const conversationGroupsUI = useAssistantFeatureFlagStore.use.conversationGroupsUI();
  const isAssistantActive = useAssistantLifecycleStore(
    (s) => s.assistantState.kind === "active",
  );

  // --- Collapse store hydration ---

  useEffect(() => {
    if (assistantId) {
      startTransition(() => {
        useSidebarCollapseStore.getState().setAssistantId(assistantId);
      });
    }
  }, [assistantId]);

  const openCategories = useSidebarCollapseStore.use.openCategories();
  const openCustomGroups = useSidebarCollapseStore.use.openCustomGroups();
  const setOpenCategories = useSidebarCollapseStore.use.setOpenCategories();
  const setOpenCustomGroups = useSidebarCollapseStore.use.setOpenCustomGroups();
  const activateBackground = useSidebarCollapseStore.use.activateBackground();
  const activateScheduled = useSidebarCollapseStore.use.activateScheduled();
  const backgroundActivated = useSidebarCollapseStore.use.backgroundActivated();
  const scheduledActivated = useSidebarCollapseStore.use.scheduledActivated();
  const collapseAssistantId = useSidebarCollapseStore.use.assistantId();

  // Background and scheduled jobs each load through their own lazy query,
  // co-located here with the sections that toggle them. A query is enabled
  // only once its section is revealed (`backgroundActivated` /
  // `scheduledActivated`) and the collapse store has synced to the current
  // assistant — so neither backlog touches the initial-load critical path,
  // and revealing one section never pulls in the other. The activation flags
  // briefly hold the previous assistant's values on a switch; gating on the
  // sync guard stops a stale flag from fetching the new assistant's backlog
  // on its first render.
  const collapseSynced = collapseAssistantId === assistantId;
  const backgroundReady = backgroundActivated && collapseSynced;
  const scheduledReady = scheduledActivated && collapseSynced;
  const {
    conversations: backgroundConversations,
    isPending: backgroundPending,
  } = useBackgroundConversationListQuery(
    assistantId,
    isAssistantActive && backgroundReady,
  );
  const backgroundLoading = backgroundReady && backgroundPending;
  const {
    conversations: scheduledConversations,
    isPending: scheduledPending,
  } = useScheduledConversationListQuery(
    assistantId,
    isAssistantActive && scheduledReady,
  );
  const scheduledLoading = scheduledReady && scheduledPending;

  const allConversations = useMemo(
    () =>
      mergeConversationLists(
        conversations,
        backgroundConversations,
        scheduledConversations,
      ),
    [conversations, backgroundConversations, scheduledConversations],
  );

  // --- Grouping (memoized per conversations reference) ---

  const grouped = useMemo(
    () =>
      groupConversations(allConversations, {
        groups: conversationGroups,
        customGroupsEnabled: conversationGroupsUI,
      }),
    [allConversations, conversationGroups, conversationGroupsUI],
  );

  const scheduledSubGroups = useMemo(
    () => groupScheduledConversationsByJobId(grouped.scheduled),
    [grouped.scheduled],
  );

  const backgroundSubGroups = useMemo(
    () => groupBackgroundConversationsBySource(grouped.background),
    [grouped.background],
  );

  // --- Pagination ("show more") ---

  const [recentsExpanded, setRecentsExpanded] = useState(false);
  const [slackExpanded, setSlackExpanded] = useState(false);

  const recentsSection = useMemo(
    () =>
      buildPaginatedSection({
        items: grouped.recents,
        isExpanded: recentsExpanded,
        attentionConversationIds,
        hasNextPage,
        fetchNextPage,
        onExpand: () => setRecentsExpanded(true),
        onCollapse: () => setRecentsExpanded(false),
      }),
    [grouped.recents, recentsExpanded, attentionConversationIds, fetchNextPage, hasNextPage],
  );

  // Slack is a client-side filtered subset of the foreground list — it has
  // no server-specific pagination. "Show more" just reveals all loaded Slack
  // items; loading more foreground pages rarely yields additional Slack items.
  const slackSection = useMemo(
    () =>
      buildPaginatedSection({
        items: grouped.slack,
        isExpanded: slackExpanded,
        attentionConversationIds,
        hasNextPage: undefined,
        fetchNextPage: undefined,
        onExpand: () => setSlackExpanded(true),
        onCollapse: () => setSlackExpanded(false),
      }),
    [grouped.slack, slackExpanded, attentionConversationIds],
  );

  // --- Attention-forced expansion ---

  const hasAttentionIn = useCallback(
    (convs: Conversation[]) =>
      attentionConversationIds
        ? convs.some((c) =>
            attentionConversationIds.has(c.conversationId),
          )
        : false,
    [attentionConversationIds],
  );

  const effectiveOpenCategories = useMemo(() => {
    if (!attentionConversationIds || attentionConversationIds.size === 0)
      return openCategories;
    const extra: string[] = [];
    if (grouped.scheduled.length > 0 && hasAttentionIn(grouped.scheduled))
      extra.push("scheduled");
    if (grouped.background.length > 0 && hasAttentionIn(grouped.background))
      extra.push("background");
    if (grouped.slack.length > 0 && hasAttentionIn(grouped.slack))
      extra.push("slack");
    if (extra.length === 0) return openCategories;
    if (extra.every((c) => openCategories.includes(c))) return openCategories;
    return [...new Set([...openCategories, ...extra])];
  }, [
    openCategories,
    attentionConversationIds,
    grouped.scheduled,
    grouped.background,
    grouped.slack,
    hasAttentionIn,
  ]);

  const effectiveOpenCustomGroups = useMemo(() => {
    if (!attentionConversationIds || attentionConversationIds.size === 0)
      return openCustomGroups;
    const extra: string[] = [];
    for (const group of grouped.customGroups) {
      if (
        group.conversations.some((c) =>
          attentionConversationIds.has(c.conversationId),
        )
      ) {
        extra.push(group.id);
      }
    }
    if (extra.length === 0) return openCustomGroups;
    if (extra.every((g) => openCustomGroups.includes(g)))
      return openCustomGroups;
    return [...new Set([...openCustomGroups, ...extra])];
  }, [openCustomGroups, attentionConversationIds, grouped.customGroups]);

  return {
    pinned: grouped.pinned,
    scheduled: grouped.scheduled,
    scheduledSubGroups,
    background: grouped.background,
    backgroundSubGroups,
    slack: slackSection,
    recents: recentsSection,
    customGroups: grouped.customGroups,
    effectiveOpenCategories,
    effectiveOpenCustomGroups,
    onOpenCategoriesChange: setOpenCategories,
    onOpenCustomGroupsChange: setOpenCustomGroups,
    conversationGroupsEnabled: conversationGroupsUI,
    activateBackground,
    backgroundLoading,
    activateScheduled,
    scheduledLoading,
  };
}
