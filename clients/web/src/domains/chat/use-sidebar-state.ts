/**
 * Data-shaping hook for the assistant sidebar.
 *
 * Owns conversation grouping, collapse/expand state, attention-forced
 * expansion, and the user's section order. Returns a
 * typed object the presentational `AssistantSideMenu` renders without any
 * inline computation, `useEffect`, or derived state.
 *
 * Two views share all of that. In `all` (the default) the sections stop at
 * the curated layer - Pinned and the custom groups - and everything else
 * renders as {@link SidebarState.flatList}, one recency-sorted list the
 * sidebar virtualizes. In `grouped`, Chats and one section per origin channel
 * follow the curated layer, and the flat list goes unused.
 *
 * The headline output is {@link SidebarState.sections}: one flat, ordered
 * list of every renderable section (Pinned, Chats, each channel, each custom
 * group) as a discriminated union. The sidebar walks that list in order -
 * it does not know which section types exist or where they "belong", which
 * is what lets the user reorder them at all. The one constraint is the view
 * switch: Pinned and the custom groups always lead it, Chats and the channel
 * sections always follow, and sections reorder freely within their own tier.
 *
 * Memoizes grouping per `conversations` reference so parent re-renders
 * that don't change the conversation list skip the grouping work.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 * @see {@link https://react.dev/reference/react/useMemo}
 */

import { useCallback, useEffect, useMemo, startTransition } from "react";

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
  isChannelSectionKey,
  isKnownCategoryKey,
  isKnownPrimaryKey,
} from "@/domains/chat/utils/sidebar-group-collapse-storage";
import {
  enforceCuratedLead,
  mergeSectionOrder,
  moveSectionKey,
  nextStoredOrder,
  type SectionOrderClass,
} from "@/domains/chat/utils/sidebar-section-order";
import {
  saveViewMode,
  useViewMode,
  type SidebarViewMode,
} from "@/domains/chat/utils/sidebar-view-mode";
import { mergeConversationLists } from "@/utils/conversation-cache";
import {
  useBackgroundConversationListQuery,
  useScheduledConversationListQuery,
} from "@/hooks/conversation-queries";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { getChannelLabel } from "@/utils/channel-presentation";
import { RECENTS_SECTION_LABEL } from "@/domains/chat/utils/sidebar-section-icon";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Shared empty array for the "no attention anywhere" case - the common one.
 * Returning a fresh `[]` would give every dependent memo a new identity on
 * each render.
 */
const EMPTY_KEYS: string[] = [];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Which side of the view switch a section sits on. Chats and the channel
 * sections are what the switch changes, so they sit under it; Pinned and the
 * custom groups are untouched by it and lead.
 */
function classifySectionKey(key: string): SectionOrderClass {
  if (key === "recents" || isChannelSectionKey(key)) {
    return "governed";
  }
  return "curated";
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
  /** Every conversation in the section. */
  all: Conversation[];
}

/**
 * One renderable sidebar section. Discriminated by `type` so the sidebar can
 * render a heterogeneous, user-ordered list without re-deriving which bucket
 * each section came from.
 */
export type SidebarSection =
  | (SidebarSectionBase & { type: "pinned" })
  | (SidebarSectionBase & { type: "recents" })
  | (SidebarSectionBase & { type: "channel"; channelId: string })
  | (SidebarSectionBase & { type: "group"; group: CustomGroup });

export interface SidebarState {
  /** Which view the sidebar renders. */
  viewMode: SidebarViewMode;
  /** Switch views and persist the choice for this assistant. */
  onViewModeChange: (next: SidebarViewMode) => void;

  /**
   * The `all` view's list: every conversation that is neither pinned nor in a
   * custom group, newest first. Windowed at render, so it carries no page
   * size or reveal state of its own.
   */
  flatList: Conversation[];

  /**
   * Every section in the user's chosen order - the list the sidebar renders
   * above the flat list. Sections the user has never touched fall back to the
   * default order (Pinned, custom groups, then - in `grouped` view - Chats
   * and the channel sections).
   */
  sections: SidebarSection[];
  /**
   * How many leading entries of {@link SidebarState.sections} are the curated
   * layer. The view switch renders at that offset, which is the tier boundary
   * `enforceCuratedLead` guarantees - so the sidebar places it without
   * re-deriving what "curated" means.
   */
  curatedSectionCount: number;
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
   * Whether {@link SidebarState.onMoveSection} would actually move anything -
   * false at the ends of the list, and for a move that would carry a section
   * across the view switch into the other tier.
   */
  canMoveSection: (key: string, delta: -1 | 1) => boolean;

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

  // Read straight from storage rather than through the layout store. The store
  // hydrates in an effect, so anything it owns renders as the default on the
  // first paint; the view mode decides which list the sidebar draws, making
  // that flash the most visible one. Subscribing instead means the stored
  // choice is there on the first paint, and a change in another window lands
  // here without a reload.
  const viewMode = useViewMode(assistantId);
  const setViewMode = useCallback(
    (next: SidebarViewMode) => {
      saveViewMode(assistantId, next);
    },
    [assistantId],
  );
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
        groupByChannel: viewMode === "grouped",
      }),
    [allConversations, conversationGroups, viewMode],
  );

  // --- Section order ---

  // Default layout: Pinned, then the user's custom groups, then - in the
  // grouped view - Chats and the channel sections. Groups lead because they
  // are the deliberate, curated organization layer, and they hold their place
  // while channel sections come and go with traffic. In the flat view the
  // sections stop at the curated layer: everything else renders as one list
  // below them.
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
    if (viewMode === "grouped") {
      list.push({
        type: "recents",
        key: "recents",
        label: RECENTS_SECTION_LABEL,
        all: grouped.recents,
      });
      for (const section of grouped.channelSections) {
        list.push({
          type: "channel",
          key: channelSectionKey(section.channelId),
          label: getChannelLabel(section.channelId),
          all: section.conversations,
          channelId: section.channelId,
        });
      }
    }
    return list;
  }, [
    viewMode,
    grouped.pinned,
    grouped.customGroups,
    grouped.recents,
    grouped.channelSections,
  ]);

  const sections = useMemo((): SidebarSection[] => {
    const defaultKeys = defaultSections.map((s) => s.key);
    const ordered =
      sectionOrder.length === 0
        ? defaultKeys
        : mergeSectionOrder(defaultKeys, sectionOrder);
    const byKey = new Map(defaultSections.map((s) => [s.key, s]));
    return enforceCuratedLead(ordered, classifySectionKey).map(
      (key) => byKey.get(key)!,
    );
  }, [defaultSections, sectionOrder]);

  const curatedSectionCount = useMemo(
    () =>
      sections.filter((section) => classifySectionKey(section.key) === "curated")
        .length,
    [sections],
  );

  const onReorderSections = useCallback(
    (orderedKeys: string[]) => {
      setSectionOrder(
        nextStoredOrder(
          sectionOrder,
          enforceCuratedLead(orderedKeys, classifySectionKey),
        ),
      );
    },
    [sectionOrder, setSectionOrder],
  );

  // The order `key` would land in after a nudge, or null when the nudge
  // changes nothing - either end of the list, or a move across the tier
  // boundary that the curated-lead rule pushes straight back.
  const orderAfterMove = useCallback(
    (key: string, delta: -1 | 1): string[] | null => {
      const current = sections.map((s) => s.key);
      const moved = moveSectionKey(current, key, delta);
      if (!moved) {
        return null;
      }
      const settled = enforceCuratedLead(moved, classifySectionKey);
      return settled.join(" ") === current.join(" ") ? null : settled;
    },
    [sections],
  );

  const onMoveSection = useCallback(
    (key: string, delta: -1 | 1) => {
      const moved = orderAfterMove(key, delta);
      if (moved) {
        setSectionOrder(nextStoredOrder(sectionOrder, moved));
      }
    },
    [orderAfterMove, sectionOrder, setSectionOrder],
  );

  const canMoveSection = useCallback(
    (key: string, delta: -1 | 1) => orderAfterMove(key, delta) !== null,
    [orderAfterMove],
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
    viewMode,
    onViewModeChange: setViewMode,
    flatList: grouped.recents,
    sections,
    curatedSectionCount,
    onReorderSections,
    onMoveSection,
    canMoveSection,
    effectiveOpenSections,
    onOpenSectionsChange,
  };
}
