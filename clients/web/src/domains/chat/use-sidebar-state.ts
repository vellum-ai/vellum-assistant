/**
 * Data-shaping hook for the assistant sidebar.
 *
 * Owns conversation grouping, pagination ("show more"), collapse/expand
 * state, attention-forced expansion, and the user's section order. Returns a
 * typed object the presentational `AssistantSideMenu` renders without any
 * inline computation, `useEffect`, or derived state.
 *
 * The headline output is {@link SidebarState.sections}: one flat, ordered
 * list of every renderable section (Pinned, Chats, each channel, each custom
 * group) as a discriminated union. The sidebar walks that list in order -
 * it does not know which section types exist or where they "belong", which
 * is what lets the user put a custom group above Recents.
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
import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";
import {
  channelSectionKey,
  isKnownCategoryKey,
  isKnownPrimaryKey,
} from "@/domains/chat/utils/sidebar-group-collapse-storage";
import {
  mergeSectionOrder,
  moveSectionKey,
  nextStoredOrder,
} from "@/domains/chat/utils/sidebar-section-order";
import { mergeConversationLists } from "@/utils/conversation-cache";
import {
  useBackgroundConversationListQuery,
  useScheduledConversationListQuery,
} from "@/hooks/conversation-queries";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { getChannelLabel } from "@/utils/channel-presentation";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const SIDEBAR_CONVERSATION_LIMIT = 5;

/**
 * Shared empty array for the "no attention anywhere" case - the common one.
 * Returning a fresh `[]` would give every dependent memo a new identity on
 * each render.
 */
const EMPTY_KEYS: string[] = [];

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

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface SidebarSectionBase {
  /**
   * Collapse key *and* section-order key - one namespace, so the two can
   * never disagree about what a section is called.
   */
  key: string;
  /** Header label. */
  label: string;
  /** Every conversation in the section, ignoring "show more" truncation. */
  all: Conversation[];
}

/**
 * One renderable sidebar section. Discriminated by `type` so the sidebar can
 * render a heterogeneous, user-ordered list without re-deriving which bucket
 * each section came from.
 */
export type SidebarSection =
  | (SidebarSectionBase & { type: "pinned" })
  | (SidebarSectionBase & { type: "recents"; pagination: PaginatedSection })
  | (SidebarSectionBase & {
      type: "channel";
      channelId: string;
      pagination: ChannelSectionState;
    })
  | (SidebarSectionBase & { type: "group"; group: CustomGroup });

export interface SidebarState {
  pinned: Conversation[];
  channelSections: ChannelSectionState[];
  recents: PaginatedSection;

  customGroups: CustomGroup[];

  /**
   * Every section in the user's chosen order - the list the sidebar renders.
   * Sections the user has never touched fall back to the default order
   * (Pinned, custom groups, Chats, channel sections).
   */
  sections: SidebarSection[];
  /**
   * Persist a new section order. Takes the full ordered key list of the
   * sections currently on screen.
   */
  onReorderSections: (orderedKeys: string[]) => void;
  /**
   * Nudge one section one slot up (`-1`) or down (`+1`) - the keyboard- and
   * touch-reachable equivalent of dragging it, since HTML5 drag events fire
   * for neither.
   */
  onMoveSection: (key: string, delta: -1 | 1) => void;

  /**
   * Open keys for the single accordion root that holds *every* section -
   * merged from the primary, category, and custom-group storage buckets.
   * One root keeps section spacing uniform and lets the three section types
   * interleave in any order.
   */
  effectiveOpenSections: string[];
  /** Splits the accordion's value array back into its three storage buckets. */
  onOpenSectionsChange: (next: string[]) => void;
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

  // --- Layout store hydration ---

  useEffect(() => {
    if (assistantId) {
      startTransition(() => {
        useSidebarLayoutStore.getState().setAssistantId(assistantId);
      });
    }
  }, [assistantId]);

  const openCategories = useSidebarLayoutStore.use.openCategories();
  const openCustomGroups = useSidebarLayoutStore.use.openCustomGroups();
  const openPrimary = useSidebarLayoutStore.use.openPrimary();
  const setOpenCategories = useSidebarLayoutStore.use.setOpenCategories();
  const setOpenCustomGroups = useSidebarLayoutStore.use.setOpenCustomGroups();
  const setOpenPrimary = useSidebarLayoutStore.use.setOpenPrimary();
  const sectionOrder = useSidebarLayoutStore.use.sectionOrder();
  const setSectionOrder = useSidebarLayoutStore.use.setSectionOrder();
  const backgroundActivated = useSidebarLayoutStore.use.backgroundActivated();
  const scheduledActivated = useSidebarLayoutStore.use.scheduledActivated();
  const collapseAssistantId = useSidebarLayoutStore.use.assistantId();

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

  // --- Section order ---

  // Default layout: Pinned, then the user's custom groups, then Chats and the
  // channel sections. Groups lead because they are the deliberate, curated
  // organization layer, and they hold their place while channel sections come
  // and go with traffic.
  const defaultSections = useMemo((): SidebarSection[] => {
    const list: SidebarSection[] = [];
    if (grouped.pinned.length > 0) {
      list.push({
        type: "pinned",
        key: "pinned",
        label: "Pinned",
        all: grouped.pinned,
      });
    }
    for (const group of grouped.customGroups) {
      list.push({
        type: "group",
        key: group.id,
        label: group.name,
        all: group.conversations,
        group,
      });
    }
    list.push({
      type: "recents",
      key: "recents",
      label: "Chats",
      all: recentsSection.all,
      pagination: recentsSection,
    });
    for (const section of channelSections) {
      list.push({
        type: "channel",
        key: channelSectionKey(section.channelId),
        label: getChannelLabel(section.channelId),
        all: section.all,
        channelId: section.channelId,
        pagination: section,
      });
    }
    return list;
  }, [
    grouped.pinned,
    grouped.customGroups,
    recentsSection,
    channelSections,
  ]);

  const sections = useMemo((): SidebarSection[] => {
    if (sectionOrder.length === 0) {
      return defaultSections;
    }
    const byKey = new Map(defaultSections.map((s) => [s.key, s]));
    return mergeSectionOrder(
      defaultSections.map((s) => s.key),
      sectionOrder,
    ).map((key) => byKey.get(key)!);
  }, [defaultSections, sectionOrder]);

  const onReorderSections = useCallback(
    (orderedKeys: string[]) => {
      setSectionOrder(nextStoredOrder(sectionOrder, orderedKeys));
    },
    [sectionOrder, setSectionOrder],
  );

  const onMoveSection = useCallback(
    (key: string, delta: -1 | 1) => {
      const moved = moveSectionKey(
        sections.map((s) => s.key),
        key,
        delta,
      );
      if (moved) {
        setSectionOrder(nextStoredOrder(sectionOrder, moved));
      }
    },
    [sections, sectionOrder, setSectionOrder],
  );

  // --- Open/closed state ---

  // The three storage buckets exist because they have different defaults
  // (Pinned/Chats open, the rest closed) and because `setOpenCategories` owns
  // the lazy-fetch activation side effects. That split is a *storage* concern:
  // every section shares one accordion root, so reads merge the buckets into
  // one value array and writes route each key back to its owner.
  const storedOpenSections = useMemo(
    () => [...openPrimary, ...openCategories, ...openCustomGroups],
    [openPrimary, openCategories, openCustomGroups],
  );

  // Sections a conversation needing attention forces open, whatever the user
  // last chose. One pass over `sections` covers every type - each section
  // already carries its own conversations, so there's nothing type-specific
  // left to special-case here.
  const attentionOpenKeys = useMemo(() => {
    if (!attentionConversationIds || attentionConversationIds.size === 0) {
      return EMPTY_KEYS;
    }
    const keys = sections
      .filter((section) =>
        section.all.some((c) =>
          attentionConversationIds.has(c.conversationId),
        ),
      )
      .map((section) => section.key);
    return keys.length > 0 ? keys : EMPTY_KEYS;
  }, [sections, attentionConversationIds]);

  // Held open by attention rather than by the user. Radix builds each
  // `onValueChange` payload from the current value array, so these ride along
  // when the user toggles some *other* section — persisting them would outlive
  // the attention that opened them and leave the section stuck open.
  const forcedOpenKeys = useMemo(() => {
    const stored = new Set(storedOpenSections);
    return new Set(attentionOpenKeys.filter((key) => !stored.has(key)));
  }, [storedOpenSections, attentionOpenKeys]);

  const effectiveOpenSections = useMemo(
    () =>
      forcedOpenKeys.size === 0
        ? storedOpenSections
        : [...new Set([...storedOpenSections, ...attentionOpenKeys])],
    [storedOpenSections, attentionOpenKeys, forcedOpenKeys],
  );

  // Routes each key from the shared root back to the bucket that owns it.
  // Anything that is neither a primary key nor a built-in category key is a
  // custom group id.
  const onOpenSectionsChange = useCallback(
    (next: string[]) => {
      const toPersist = next.filter((key) => !forcedOpenKeys.has(key));
      setOpenPrimary(toPersist.filter(isKnownPrimaryKey));
      setOpenCategories(toPersist.filter(isKnownCategoryKey));
      setOpenCustomGroups(
        toPersist.filter(
          (key) => !isKnownPrimaryKey(key) && !isKnownCategoryKey(key),
        ),
      );
    },
    [forcedOpenKeys, setOpenPrimary, setOpenCategories, setOpenCustomGroups],
  );

  return {
    pinned: grouped.pinned,
    channelSections,
    recents: recentsSection,
    customGroups: grouped.customGroups,
    sections,
    onReorderSections,
    onMoveSection,
    effectiveOpenSections,
    onOpenSectionsChange,
  };
}
