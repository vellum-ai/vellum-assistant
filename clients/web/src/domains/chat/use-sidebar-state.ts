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

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  startTransition,
} from "react";

import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import {
  groupConversations,
  type CustomGroup,
} from "@/domains/chat/utils/group-conversations";
import { useSidebarCollapseStore } from "@/domains/chat/sidebar-collapse-store";
import {
  channelSectionKey,
  isKnownPrimaryKey,
} from "@/domains/chat/utils/sidebar-group-collapse-storage";
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

export interface SidebarState {
  pinned: Conversation[];
  channelSections: ChannelSectionState[];
  recents: PaginatedSection;

  customGroups: CustomGroup[];

  /**
   * Open keys for the single accordion root that holds Pinned, Chats, and
   * every channel section — merged from the primary and category storage
   * buckets so all of them share one root (and therefore one uniform gap).
   */
  effectiveOpenSections: string[];
  /** Splits the accordion's value array back into its two storage buckets. */
  onOpenSectionsChange: (next: string[]) => void;

  effectiveOpenCustomGroups: string[];
  onOpenCustomGroupsChange: (next: string[]) => void;
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
  const { conversations: backgroundConversations } =
    useBackgroundConversationListQuery(
      assistantId,
      isAssistantActive && backgroundReady,
    );
  const { conversations: scheduledConversations } =
    useScheduledConversationListQuery(
      assistantId,
      isAssistantActive && scheduledReady,
    );

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

  const hasAttentionIn = useCallback(
    (convs: Conversation[]) =>
      attentionConversationIds
        ? convs.some((c) => attentionConversationIds.has(c.conversationId))
        : false,
    [attentionConversationIds],
  );

  const effectiveOpenCategories = useMemo(() => {
    if (!attentionConversationIds || attentionConversationIds.size === 0) {
      return openCategories;
    }
    const extra: string[] = [];
    for (const section of grouped.channelSections) {
      if (
        section.conversations.length > 0 &&
        hasAttentionIn(section.conversations)
      ) {
        extra.push(channelSectionKey(section.channelId));
      }
    }
    if (extra.length === 0) {
      return openCategories;
    }
    if (extra.every((c) => openCategories.includes(c))) {
      return openCategories;
    }
    return [...new Set([...openCategories, ...extra])];
  }, [
    openCategories,
    attentionConversationIds,
    grouped.channelSections,
    hasAttentionIn,
  ]);

  const effectiveOpenCustomGroups = useMemo(() => {
    if (!attentionConversationIds || attentionConversationIds.size === 0) {
      return openCustomGroups;
    }
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
    if (extra.length === 0) {
      return openCustomGroups;
    }
    if (extra.every((g) => openCustomGroups.includes(g))) {
      return openCustomGroups;
    }
    return [...new Set([...openCustomGroups, ...extra])];
  }, [openCustomGroups, attentionConversationIds, grouped.customGroups]);

  // Pinned and Chats default open; force-open still applies if the user
  // collapsed one and a conversation in it needs attention.
  const effectiveOpenPrimary = useMemo(() => {
    if (!attentionConversationIds || attentionConversationIds.size === 0) {
      return openPrimary;
    }
    const extra: string[] = [];
    if (grouped.pinned.length > 0 && hasAttentionIn(grouped.pinned)) {
      extra.push("pinned");
    }
    if (grouped.recents.length > 0 && hasAttentionIn(grouped.recents)) {
      extra.push("recents");
    }
    if (extra.length === 0) {
      return openPrimary;
    }
    if (extra.every((k) => openPrimary.includes(k))) {
      return openPrimary;
    }
    return [...new Set([...openPrimary, ...extra])];
  }, [
    openPrimary,
    attentionConversationIds,
    grouped.pinned,
    grouped.recents,
    hasAttentionIn,
  ]);

  // Pinned/Chats and the channel sections render in one accordion root, so
  // their two storage buckets are merged into a single value array here and
  // split apart again on change. The buckets stay separate because they have
  // different defaults (primary open, categories closed) and because
  // `setOpenCategories` owns the lazy-fetch activation side effects.
  const effectiveOpenSections = useMemo(
    () => [...effectiveOpenPrimary, ...effectiveOpenCategories],
    [effectiveOpenPrimary, effectiveOpenCategories],
  );

  // Sections held open by attention rather than by the user. Radix builds each
  // `onValueChange` payload from the current value array, so these ride along
  // when the user toggles some *other* section — persisting them would outlive
  // the attention that opened them and leave the section stuck open.
  const forcedOpenKeys = useMemo(() => {
    const stored = new Set([
      ...openPrimary,
      ...openCategories,
      ...openCustomGroups,
    ]);
    return new Set(
      [
        ...effectiveOpenPrimary,
        ...effectiveOpenCategories,
        ...effectiveOpenCustomGroups,
      ].filter((key) => !stored.has(key)),
    );
  }, [
    openPrimary,
    openCategories,
    openCustomGroups,
    effectiveOpenPrimary,
    effectiveOpenCategories,
    effectiveOpenCustomGroups,
  ]);

  const onOpenSectionsChange = useCallback(
    (next: string[]) => {
      const toPersist = next.filter((key) => !forcedOpenKeys.has(key));
      setOpenPrimary(toPersist.filter(isKnownPrimaryKey));
      setOpenCategories(toPersist.filter((key) => !isKnownPrimaryKey(key)));
    },
    [forcedOpenKeys, setOpenPrimary, setOpenCategories],
  );

  // Custom groups render in their own root but are force-opened by attention
  // the same way, so their writes need the same filter.
  const onOpenCustomGroupsChange = useCallback(
    (next: string[]) => {
      setOpenCustomGroups(next.filter((key) => !forcedOpenKeys.has(key)));
    },
    [forcedOpenKeys, setOpenCustomGroups],
  );

  return {
    pinned: grouped.pinned,
    channelSections,
    recents: recentsSection,
    customGroups: grouped.customGroups,
    effectiveOpenSections,
    onOpenSectionsChange,
    effectiveOpenCustomGroups,
    onOpenCustomGroupsChange,
  };
}
