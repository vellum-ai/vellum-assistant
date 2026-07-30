/**
 * Zustand store for the per-assistant sidebar section layout: which sections
 * are expanded, and what order the user put them in.
 *
 * Replaces the two `useState` + `useEffect` + manual `localStorage`
 * read/write pairs that previously lived inside `AssistantSideMenu`.
 *
 * **Storage model:**
 *
 * - Built-in collapsible categories (scheduled, background, slack)
 *   and custom groups are stored as two separate `string[]` values,
 *   keyed per assistant. This mirrors the Radix Accordion `value` prop
 *   for `type="multiple"`.
 * - Section order is a third `string[]`, an advisory preference list over
 *   the same key namespace - see `utils/sidebar-section-order.ts`.
 * - Reads happen synchronously from localStorage on `setAssistantId`;
 *   writes happen on every toggle via `persist` helpers.
 * - Defaults to no open built-in categories, no open custom groups, and the
 *   built-in default section order when no stored state exists.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import {
  loadOpenCategories,
  loadOpenCustomGroups,
  loadOpenPrimary,
  PRIMARY_SECTION_KEYS,
  saveOpenCategories,
  saveOpenCustomGroups,
  saveOpenPrimary,
} from "@/domains/chat/utils/sidebar-group-collapse-storage";
import {
  loadSectionOrder,
  saveSectionOrder,
} from "@/domains/chat/utils/sidebar-section-order";

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface SidebarLayoutState {
  assistantId: string | null;
  openCategories: string[];
  openCustomGroups: string[];
  /**
   * Open state of the always-present primary sections (Pinned, Chats).
   * Defaults to both open (see {@link loadOpenPrimary}).
   */
  openPrimary: string[];
  /**
   * The user's section order preference - a sparse, advisory list of section
   * keys, not the set of sections that render. Empty means "no preference
   * yet, use the default order". Resolved against the live sections by
   * `mergeSectionOrder`.
   */
  sectionOrder: string[];
  /**
   * Whether the user has revealed the Background section this session -
   * either by expanding it in the full sidebar or opening its rail flyout.
   * Gates the lazy background conversation fetch so it never runs on the
   * initial load path. Transient (not persisted) and reset when the active
   * assistant changes.
   */
  backgroundActivated: boolean;
  /**
   * Whether the user has revealed the Scheduled section this session.
   * Tracked independently from `backgroundActivated` so revealing one
   * section never triggers the other section's lazy fetch - the Scheduled
   * and Background lists are separate queries.
   */
  scheduledActivated: boolean;
}

export interface SidebarLayoutActions {
  setAssistantId: (assistantId: string) => void;
  setOpenCategories: (next: string[]) => void;
  setOpenCustomGroups: (next: string[]) => void;
  setOpenPrimary: (next: string[]) => void;
  setSectionOrder: (next: string[]) => void;
  activateBackground: () => void;
  activateScheduled: () => void;
}

export type SidebarLayoutStore = SidebarLayoutState &
  SidebarLayoutActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: SidebarLayoutState = {
  assistantId: null,
  openCategories: [],
  openCustomGroups: [],
  // Pinned + Chats start open; the real per-assistant value loads on
  // setAssistantId.
  openPrimary: [...PRIMARY_SECTION_KEYS],
  sectionOrder: [],
  backgroundActivated: false,
  scheduledActivated: false,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useSidebarLayoutStoreBase = create<SidebarLayoutStore>()(
  (set, get) => ({
    ...INITIAL_STATE,

    setAssistantId: (assistantId: string) => {
      if (get().assistantId === assistantId) {
        return;
      }
      const openCategories = loadOpenCategories(assistantId);
      set({
        assistantId,
        openCategories,
        openCustomGroups: loadOpenCustomGroups(assistantId),
        openPrimary: loadOpenPrimary(assistantId),
        sectionOrder: loadSectionOrder(assistantId),
        // A persisted expanded section counts as a reveal, so each lazy
        // fetch resumes for assistants the user already had that section
        // open on - tracked per section so they stay independent.
        backgroundActivated: openCategories.includes("background"),
        scheduledActivated: openCategories.includes("scheduled"),
      });
    },

    setOpenCategories: (next: string[]) => {
      set((prev) => ({
        openCategories: next,
        backgroundActivated:
          prev.backgroundActivated || next.includes("background"),
        scheduledActivated:
          prev.scheduledActivated || next.includes("scheduled"),
      }));
      const { assistantId } = get();
      if (assistantId) {
        saveOpenCategories(assistantId, next);
      }
    },

    setOpenCustomGroups: (next: string[]) => {
      set({ openCustomGroups: next });
      const { assistantId } = get();
      if (assistantId) {
        saveOpenCustomGroups(assistantId, next);
      }
    },

    setOpenPrimary: (next: string[]) => {
      set({ openPrimary: next });
      const { assistantId } = get();
      if (assistantId) {
        saveOpenPrimary(assistantId, next);
      }
    },

    setSectionOrder: (next: string[]) => {
      set({ sectionOrder: next });
      const { assistantId } = get();
      if (assistantId) {
        saveSectionOrder(assistantId, next);
      }
    },

    activateBackground: () => {
      if (get().backgroundActivated) {
        return;
      }
      set({ backgroundActivated: true });
    },

    activateScheduled: () => {
      if (get().scheduledActivated) {
        return;
      }
      set({ scheduledActivated: true });
    },
  }),
);

export const useSidebarLayoutStore = createSelectors(
  useSidebarLayoutStoreBase,
);
