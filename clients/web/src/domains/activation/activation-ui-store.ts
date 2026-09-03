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
}

interface ActivationUiActions {
  /** Open a row, or collapse it when it is already the open one. */
  toggleTask: (taskId: string) => void;
  setExpandedTaskId: (taskId: string | null) => void;
  setShowMore: (showMore: boolean) => void;
  /** Drops every transient choice; the next assistant starts from the default view. */
  resetTransientState: () => void;
  openModal: () => void;
  closeModal: () => void;
}

type ActivationUiStore = ActivationUiState & ActivationUiActions;

const useActivationUiStoreBase = create<ActivationUiStore>((set) => ({
  expandedTaskId: null,
  showMore: false,
  modalReopened: false,
  toggleTask: (taskId) =>
    set((state) => ({
      expandedTaskId: state.expandedTaskId === taskId ? null : taskId,
    })),
  setExpandedTaskId: (taskId) => set({ expandedTaskId: taskId }),
  setShowMore: (showMore) => set({ showMore }),
  resetTransientState: () =>
    set({ expandedTaskId: null, showMore: false, modalReopened: false }),
  openModal: () => set({ modalReopened: true }),
  closeModal: () => set({ modalReopened: false }),
}));

export const useActivationUiStore = createSelectors(useActivationUiStoreBase);
