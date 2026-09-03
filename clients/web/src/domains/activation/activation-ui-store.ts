/**
 * Transient UI state for the activation surfaces: which row is open, whether
 * the rest of the catalog is expanded, and whether the pill has reopened the
 * modal.
 *
 * Server state never lands here. Which tasks are started or done, their step
 * counts, and whether a surface was dismissed all live in the daemon and are
 * read through `useActivationProgress`; copying any of it into a store would
 * give the pill and the modal two answers that drift apart.
 *
 * The store is app-level rather than component-level because the pill and the
 * modal are mounted in different parts of the tree and the pill reopens the
 * modal.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

import type { ActivationSurface } from "./hooks/use-activation-visibility";

interface ActivationUiState {
  /** The expanded row, or null when every row is collapsed. One at a time. */
  expandedTaskId: string | null;
  /** Whether the catalog beyond the three starters is expanded inline. */
  showMore: boolean;
  /**
   * Reopen override for the pill. The daemon's `modalDismissedAt` says the
   * modal is closed for good; this says the user asked for it back in this
   * session, and it is cleared when they close it again.
   */
  modalReopened: boolean;
  /**
   * The surface the user has closed here, ahead of the daemon.
   *
   * The visible surface is derived from a server-backed read, so without this
   * a blocking dialog would stay on screen until the write and its refetch
   * landed, and a write that failed would leave it there for good. Naming the
   * surface rather than holding a bare flag keeps the celebration reachable
   * after the welcome modal has been closed: they are different surfaces and
   * only one of them is closed at a time.
   */
  closedSurface: ActivationSurface | null;
}

interface ActivationUiActions {
  /** Open a row, or collapse it when it is already the open one. */
  toggleTask: (taskId: string) => void;
  setExpandedTaskId: (taskId: string | null) => void;
  setShowMore: (showMore: boolean) => void;
  setClosedSurface: (surface: ActivationSurface | null) => void;
  /**
   * Drops every transient choice. The single reset: an expanded row, Show
   * More, a pill reopen and a local dismissal all belong to one assistant's
   * checklist, and the next assistant starts from the default view.
   */
  resetTransientState: () => void;
  openModal: () => void;
  closeModal: () => void;
}

type ActivationUiStore = ActivationUiState & ActivationUiActions;

const useActivationUiStoreBase = create<ActivationUiStore>((set) => ({
  expandedTaskId: null,
  showMore: false,
  modalReopened: false,
  closedSurface: null,
  toggleTask: (taskId) =>
    set((state) => ({
      expandedTaskId: state.expandedTaskId === taskId ? null : taskId,
    })),
  setExpandedTaskId: (taskId) => set({ expandedTaskId: taskId }),
  setShowMore: (showMore) => set({ showMore }),
  setClosedSurface: (closedSurface) => set({ closedSurface }),
  resetTransientState: () =>
    set({
      expandedTaskId: null,
      showMore: false,
      modalReopened: false,
      closedSurface: null,
    }),
  openModal: () => set({ modalReopened: true }),
  closeModal: () => set({ modalReopened: false }),
}));

export const useActivationUiStore = createSelectors(useActivationUiStoreBase);
