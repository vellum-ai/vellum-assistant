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
  /**
   * Whether the user has revealed the Background section this session —
   * either by expanding it in the full sidebar or opening its rail flyout.
   * Gates the lazy background conversation fetch so it never runs on the
   * initial load path. Transient (not persisted) and reset when the active
   * assistant changes.
   */
  backgroundActivated: boolean;
  /**
   * Whether the user has revealed the Scheduled section this session.
   * Tracked independently from `backgroundActivated` so revealing one
   * section never triggers the other section's lazy fetch — the Scheduled
   * and Background lists are separate queries.
   */
  scheduledActivated: boolean;
}

export interface SidebarCollapseActions {
  setAssistantId: (assistantId: string) => void;
  setOpenCategories: (next: string[]) => void;
  setOpenCustomGroups: (next: string[]) => void;
  activateBackground: () => void;
  activateScheduled: () => void;
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
  backgroundActivated: false,
  scheduledActivated: false,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useSidebarCollapseStoreBase = create<SidebarCollapseStore>()(
  (set, get) => ({
    ...INITIAL_STATE,

    setAssistantId: (assistantId: string) => {
      if (get().assistantId === assistantId) return;
      const openCategories = loadOpenCategories(assistantId);
      set({
        assistantId,
        openCategories,
        openCustomGroups: loadOpenCustomGroups(assistantId),
        // A persisted expanded section counts as a reveal, so each lazy
        // fetch resumes for assistants the user already had that section
        // open on — tracked per section so they stay independent.
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
      if (assistantId) saveOpenCategories(assistantId, next);
    },

    setOpenCustomGroups: (next: string[]) => {
      set({ openCustomGroups: next });
      const { assistantId } = get();
      if (assistantId) saveOpenCustomGroups(assistantId, next);
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

export const useSidebarCollapseStore = createSelectors(
  useSidebarCollapseStoreBase,
);
