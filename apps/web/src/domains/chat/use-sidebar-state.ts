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

import type { Conversation, ConversationGroup } from "@/domains/chat/api/conversations.js";
import { groupConversations, type CustomGroup } from "@/domains/chat/utils/group-conversations.js";
import { groupBackgroundConversationsBySource } from "@/domains/chat/utils/background-sub-groups.js";
import { groupScheduledConversationsByJobId } from "@/domains/chat/utils/scheduled-sub-groups.js";
import type { SubGroup } from "@/domains/chat/utils/sub-group-utils.js";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store.js";
import { useSidebarCollapseStore } from "@/domains/chat/sidebar-collapse-store.js";

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
  onShowMore: () => void;
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

  // --- Grouping (memoized per conversations reference) ---

  const grouped = useMemo(
    () =>
      groupConversations(conversations, {
        groups: conversationGroups,
        customGroupsEnabled: conversationGroupsUI,
      }),
    [conversations, conversationGroups, conversationGroupsUI],
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

  const [showAllRecents, setShowAllRecents] = useState(false);
  const [showAllSlack, setShowAllSlack] = useState(false);

  const recentsSection = useMemo((): PaginatedSection => {
    const hasAttentionBeyondLimit =
      !showAllRecents &&
      grouped.recents.length > SIDEBAR_CONVERSATION_LIMIT &&
      attentionConversationIds != null &&
      grouped.recents
        .slice(SIDEBAR_CONVERSATION_LIMIT)
        .some((c) => attentionConversationIds.has(c.conversationId));
    const effectiveShowAll = showAllRecents || !!hasAttentionBeyondLimit;
    return {
      all: grouped.recents,
      items: effectiveShowAll
        ? grouped.recents
        : grouped.recents.slice(0, SIDEBAR_CONVERSATION_LIMIT),
      totalCount: grouped.recents.length,
      showMore:
        !effectiveShowAll &&
        grouped.recents.length > SIDEBAR_CONVERSATION_LIMIT,
      onShowMore: () => setShowAllRecents(true),
    };
  }, [grouped.recents, showAllRecents, attentionConversationIds]);

  const slackSection = useMemo((): PaginatedSection => {
    const hasAttentionBeyondLimit =
      !showAllSlack &&
      grouped.slack.length > SIDEBAR_CONVERSATION_LIMIT &&
      attentionConversationIds != null &&
      grouped.slack
        .slice(SIDEBAR_CONVERSATION_LIMIT)
        .some((c) => attentionConversationIds.has(c.conversationId));
    const effectiveShowAll = showAllSlack || !!hasAttentionBeyondLimit;
    return {
      all: grouped.slack,
      items: effectiveShowAll
        ? grouped.slack
        : grouped.slack.slice(0, SIDEBAR_CONVERSATION_LIMIT),
      totalCount: grouped.slack.length,
      showMore:
        !effectiveShowAll &&
        grouped.slack.length > SIDEBAR_CONVERSATION_LIMIT,
      onShowMore: () => setShowAllSlack(true),
    };
  }, [grouped.slack, showAllSlack, attentionConversationIds]);

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
    if (grouped.pinned.length > 0 && hasAttentionIn(grouped.pinned))
      extra.push("pinned");
    if (grouped.scheduled.length > 0 && hasAttentionIn(grouped.scheduled))
      extra.push("scheduled");
    if (grouped.background.length > 0 && hasAttentionIn(grouped.background))
      extra.push("background");
    if (grouped.slack.length > 0 && hasAttentionIn(grouped.slack))
      extra.push("slack");
    if (grouped.recents.length > 0 && hasAttentionIn(grouped.recents))
      extra.push("recents");
    if (extra.length === 0) return openCategories;
    if (extra.every((c) => openCategories.includes(c))) return openCategories;
    return [...new Set([...openCategories, ...extra])];
  }, [
    openCategories,
    attentionConversationIds,
    grouped.pinned,
    grouped.scheduled,
    grouped.background,
    grouped.slack,
    grouped.recents,
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
  };
}
