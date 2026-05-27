/**
 * Zustand store for sidebar section collapse/expand state.
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
 * - Reads happen synchronously from localStorage on `setAssistantId`;
 *   writes happen on every toggle via `persist` helpers.
 * - Defaults to no open built-in categories and no open custom groups
 *   when no stored state exists.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import {
  loadOpenCategories,
  loadOpenCustomGroups,
  saveOpenCategories,
  saveOpenCustomGroups,
} from "@/domains/chat/utils/sidebar-group-collapse-storage";

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface SidebarCollapseState {
  assistantId: string | null;
  openCategories: string[];
  openCustomGroups: string[];
}

export interface SidebarCollapseActions {
  setAssistantId: (assistantId: string) => void;
  setOpenCategories: (next: string[]) => void;
  setOpenCustomGroups: (next: string[]) => void;
}

export type SidebarCollapseStore = SidebarCollapseState &
  SidebarCollapseActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: SidebarCollapseState = {
  assistantId: null,
  openCategories: [],
  openCustomGroups: [],
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useSidebarCollapseStoreBase = create<SidebarCollapseStore>()(
  (set, get) => ({
    ...INITIAL_STATE,

    setAssistantId: (assistantId: string) => {
      if (get().assistantId === assistantId) return;
      set({
        assistantId,
        openCategories: loadOpenCategories(assistantId),
        openCustomGroups: loadOpenCustomGroups(assistantId),
      });
    },

    setOpenCategories: (next: string[]) => {
      set({ openCategories: next });
      const { assistantId } = get();
      if (assistantId) saveOpenCategories(assistantId, next);
    },

    setOpenCustomGroups: (next: string[]) => {
      set({ openCustomGroups: next });
      const { assistantId } = get();
      if (assistantId) saveOpenCustomGroups(assistantId, next);
    },
  }),
);

export const useSidebarCollapseStore = createSelectors(
  useSidebarCollapseStoreBase,
);
