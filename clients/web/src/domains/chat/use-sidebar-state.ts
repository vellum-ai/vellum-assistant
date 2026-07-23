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

import { useEffect, useMemo, useState, startTransition } from "react";

import type { Conversation, ConversationGroup } from "@/types/conversation-types";
import { groupConversations, type CustomGroup } from "@/domains/chat/utils/group-conversations";
import { groupBackgroundConversationsBySource } from "@/domains/chat/utils/background-sub-groups";
import { groupScheduledConversationsByJobId } from "@/domains/chat/utils/scheduled-sub-groups";
import type { SubGroup } from "@/domains/chat/utils/sub-group";
import { useSidebarCollapseStore } from "@/domains/chat/sidebar-collapse-store";
import { channelSectionKey } from "@/domains/chat/utils/sidebar-group-collapse-storage";
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
  /**
   * At most one of `showMore` / `showLess` is true: "Show more" while
   * items remain hidden, "Show less" only once the section is fully
   * revealed past the default limit.
   */
  showMore: boolean;
  showLess: boolean;
  onShowMore: () => void;
  onShowLess: () => void;
}

/** A paginated sidebar section bound to a specific origin channel. */
export interface ChannelSectionState extends PaginatedSection {
  channelId: string;
}

/**
 * Shape a conversation list into a paginated sidebar section. Shared by the
 * Recents section and every per-channel section so the "show more / show
 * less" and attention-reveal behavior stays identical across them.
 */
function buildPaginatedSection(
  all: Conversation[],
  visibleCount: number,
  setVisibleCount: (updater: (prev: number) => number) => void,
  attentionConversationIds?: Set<string>,
): PaginatedSection {
  const attentionIndex = attentionConversationIds
    ? all.findIndex((c) => attentionConversationIds.has(c.conversationId))
    : -1;
  // Force enough rows visible to reveal a conversation that needs attention.
  const effectiveVisibleCount =
    attentionIndex >= visibleCount ? attentionIndex + 1 : visibleCount;
  const showMore = effectiveVisibleCount < all.length;
  return {
    all,
    items: all.slice(0, effectiveVisibleCount),
    totalCount: all.length,
    showMore,
    // Never alongside showMore — two stacked, contradictory affordances.
    // Collapse is offered only once the section is fully revealed.
    showLess:
      !showMore &&
      visibleCount > SIDEBAR_CONVERSATION_LIMIT &&
      all.length > SIDEBAR_CONVERSATION_LIMIT,
    onShowMore: () =>
      setVisibleCount((prev) =>
        Math.min(
          all.length,
          Math.max(prev, effectiveVisibleCount) + SIDEBAR_CONVERSATION_LIMIT,
        ),
      ),
    onShowLess: () => setVisibleCount(() => SIDEBAR_CONVERSATION_LIMIT),
  };
}

interface AttentionSection {
  /** The section's collapse key (matches its `CollapsibleNavSection.Section`). */
  key: string;
  conversations: Conversation[];
}

/**
 * Merge a persisted open-set with any sections that currently hold an
 * attention-flagged conversation, so their indicator stays reachable even when
 * the user has collapsed them. The forced-open keys are not persisted. Returns
 * the original `open` reference when nothing needs forcing so memoized
 * consumers stay referentially stable.
 */
function withAttentionForcedOpen(
  open: string[],
  attentionConversationIds: Set<string> | undefined,
  sections: AttentionSection[],
): string[] {
  if (!attentionConversationIds || attentionConversationIds.size === 0) {
    return open;
  }
  const extra = sections
    .filter((s) =>
      s.conversations.some((c) =>
        attentionConversationIds.has(c.conversationId),
      ),
    )
    .map((s) => s.key);
  if (extra.every((k) => open.includes(k))) {
    return open;
  }
  return [...new Set([...open, ...extra])];
}

export interface SidebarState {
  pinned: Conversation[];

  scheduled: Conversation[];
  scheduledSubGroups: SubGroup[];

  background: Conversation[];
  backgroundSubGroups: SubGroup[];

  channelSections: ChannelSectionState[];
  recents: PaginatedSection;

  customGroups: CustomGroup[];

  effectiveOpenCategories: string[];
  effectiveOpenCustomGroups: string[];
  effectiveOpenPrimary: string[];
  onOpenCategoriesChange: (next: string[]) => void;
  onOpenCustomGroupsChange: (next: string[]) => void;
  onOpenPrimaryChange: (next: string[]) => void;

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
  const openPrimary = useSidebarCollapseStore.use.openPrimary();
  const setOpenCategories = useSidebarCollapseStore.use.setOpenCategories();
  const setOpenCustomGroups = useSidebarCollapseStore.use.setOpenCustomGroups();
  const setOpenPrimary = useSidebarCollapseStore.use.setOpenPrimary();
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
      }),
    [allConversations, conversationGroups],
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
  // Per-channel "show more" counts, keyed by channel id. Channels absent from
  // the map default to SIDEBAR_CONVERSATION_LIMIT.
  const [visibleChannelCounts, setVisibleChannelCounts] = useState<
    Record<string, number>
  >({});

  const recentsSection = useMemo(
    (): PaginatedSection =>
      buildPaginatedSection(
        grouped.recents,
        visibleRecentsCount,
        setVisibleRecentsCount,
        attentionConversationIds,
      ),
    [grouped.recents, visibleRecentsCount, attentionConversationIds],
  );

  const channelSections = useMemo(
    (): ChannelSectionState[] =>
      grouped.channelSections.map((section) => ({
        channelId: section.channelId,
        ...buildPaginatedSection(
          section.conversations,
          visibleChannelCounts[section.channelId] ?? SIDEBAR_CONVERSATION_LIMIT,
          (updater) =>
            setVisibleChannelCounts((prev) => ({
              ...prev,
              [section.channelId]: updater(
                prev[section.channelId] ?? SIDEBAR_CONVERSATION_LIMIT,
              ),
            })),
          attentionConversationIds,
        ),
      })),
    [grouped.channelSections, visibleChannelCounts, attentionConversationIds],
  );

  // --- Attention-forced expansion ---
  //
  // Each effective-open set force-opens (without persisting) any of its
  // sections that hold an attention-flagged conversation, via the shared
  // withAttentionForcedOpen helper. Only the section list differs.

  const effectiveOpenCategories = useMemo(
    () =>
      withAttentionForcedOpen(openCategories, attentionConversationIds, [
        { key: "scheduled", conversations: grouped.scheduled },
        { key: "background", conversations: grouped.background },
        ...grouped.channelSections.map((s) => ({
          key: channelSectionKey(s.channelId),
          conversations: s.conversations,
        })),
      ]),
    [
      openCategories,
      attentionConversationIds,
      grouped.scheduled,
      grouped.background,
      grouped.channelSections,
    ],
  );

  const effectiveOpenCustomGroups = useMemo(
    () =>
      withAttentionForcedOpen(
        openCustomGroups,
        attentionConversationIds,
        grouped.customGroups.map((g) => ({
          key: g.id,
          conversations: g.conversations,
        })),
      ),
    [openCustomGroups, attentionConversationIds, grouped.customGroups],
  );

  // Pinned and Chats default open; force-open still applies if the user has
  // collapsed one and a conversation in it needs attention.
  const effectiveOpenPrimary = useMemo(
    () =>
      withAttentionForcedOpen(openPrimary, attentionConversationIds, [
        { key: "pinned", conversations: grouped.pinned },
        { key: "recents", conversations: grouped.recents },
      ]),
    [openPrimary, attentionConversationIds, grouped.pinned, grouped.recents],
  );

  return {
    pinned: grouped.pinned,
    scheduled: grouped.scheduled,
    scheduledSubGroups,
    background: grouped.background,
    backgroundSubGroups,
    channelSections,
    recents: recentsSection,
    customGroups: grouped.customGroups,
    effectiveOpenCategories,
    effectiveOpenCustomGroups,
    effectiveOpenPrimary,
    onOpenCategoriesChange: setOpenCategories,
    onOpenCustomGroupsChange: setOpenCustomGroups,
    onOpenPrimaryChange: setOpenPrimary,
    activateBackground,
    backgroundLoading,
    activateScheduled,
    scheduledLoading,
  };
}
