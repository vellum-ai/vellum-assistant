/**
 * Zustand store for the per-assistant sidebar section layout: which sections
 * are expanded, and what order the user put them in.
 *
 * Replaces the two `useState` + `useEffect` + manual `localStorage`
 * read/write pairs that previously lived inside `AssistantSideMenu`.
 *
 * **Storage model:**
 *
 * - Built-in collapsible categories (the per-channel sections)
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
}

export interface SidebarLayoutActions {
  setAssistantId: (assistantId: string) => void;
  setOpenCategories: (next: string[]) => void;
  setOpenCustomGroups: (next: string[]) => void;
  setOpenPrimary: (next: string[]) => void;
  setSectionOrder: (next: string[]) => void;
}

export type SidebarLayoutStore = SidebarLayoutState & SidebarLayoutActions;

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
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useSidebarLayoutStoreBase = create<SidebarLayoutStore>()((set, get) => ({
  ...INITIAL_STATE,

  setAssistantId: (assistantId: string) => {
    if (get().assistantId === assistantId) {
      return;
    }
    set({
      assistantId,
      openCategories: loadOpenCategories(assistantId),
      openCustomGroups: loadOpenCustomGroups(assistantId),
      openPrimary: loadOpenPrimary(assistantId),
      sectionOrder: loadSectionOrder(assistantId),
    });
  },

  setOpenCategories: (next: string[]) => {
    set({ openCategories: next });
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
}));

export const useSidebarLayoutStore = createSelectors(useSidebarLayoutStoreBase);
