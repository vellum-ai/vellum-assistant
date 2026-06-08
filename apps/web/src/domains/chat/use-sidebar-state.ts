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
  all: Conversation[];
  items: Conversation[];
  totalCount: number;
  showMore: boolean;
  showLess: boolean;
  onShowMore: () => void;
  onShowLess: () => void;
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
// Hook
// ---------------------------------------------------------------------------

export interface UseSidebarStateParams {
  assistantId: string;
  conversations: Conversation[];
  conversationGroups?: ConversationGroup[];
  attentionConversationIds?: Set<string>;
}

export function useSidebarState({
  assistantId,
  conversations,
  conversationGroups,
  attentionConversationIds,
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

  const [visibleRecentsCount, setVisibleRecentsCount] = useState(
    SIDEBAR_CONVERSATION_LIMIT,
  );
  const [visibleSlackCount, setVisibleSlackCount] = useState(
    SIDEBAR_CONVERSATION_LIMIT,
  );

  const recentsSection = useMemo((): PaginatedSection => {
    const attentionIndex = attentionConversationIds
      ? grouped.recents.findIndex((c) =>
          attentionConversationIds.has(c.conversationId),
        )
      : -1;
    const effectiveVisibleCount =
      attentionIndex >= visibleRecentsCount
        ? attentionIndex + 1
        : visibleRecentsCount;
    return {
      all: grouped.recents,
      items: grouped.recents.slice(0, effectiveVisibleCount),
      totalCount: grouped.recents.length,
      showMore: effectiveVisibleCount < grouped.recents.length,
      showLess:
        visibleRecentsCount > SIDEBAR_CONVERSATION_LIMIT &&
        grouped.recents.length > SIDEBAR_CONVERSATION_LIMIT,
      onShowMore: () =>
        setVisibleRecentsCount((prev) =>
          Math.min(
            grouped.recents.length,
            Math.max(prev, effectiveVisibleCount) + SIDEBAR_CONVERSATION_LIMIT,
          ),
        ),
      onShowLess: () => setVisibleRecentsCount(SIDEBAR_CONVERSATION_LIMIT),
    };
  }, [grouped.recents, visibleRecentsCount, attentionConversationIds]);

  const slackSection = useMemo((): PaginatedSection => {
    const attentionIndex = attentionConversationIds
      ? grouped.slack.findIndex((c) =>
          attentionConversationIds.has(c.conversationId),
        )
      : -1;
    const effectiveVisibleCount =
      attentionIndex >= visibleSlackCount
        ? attentionIndex + 1
        : visibleSlackCount;
    return {
      all: grouped.slack,
      items: grouped.slack.slice(0, effectiveVisibleCount),
      totalCount: grouped.slack.length,
      showMore: effectiveVisibleCount < grouped.slack.length,
      showLess:
        visibleSlackCount > SIDEBAR_CONVERSATION_LIMIT &&
        grouped.slack.length > SIDEBAR_CONVERSATION_LIMIT,
      onShowMore: () =>
        setVisibleSlackCount((prev) =>
          Math.min(
            grouped.slack.length,
            Math.max(prev, effectiveVisibleCount) + SIDEBAR_CONVERSATION_LIMIT,
          ),
        ),
      onShowLess: () => setVisibleSlackCount(SIDEBAR_CONVERSATION_LIMIT),
    };
  }, [grouped.slack, visibleSlackCount, attentionConversationIds]);

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
