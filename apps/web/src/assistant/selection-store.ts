/**
 * Active-assistant selection.
 *
 * Single source of truth for which assistant the app is acting on.
 * Selection state, not server state — lives in Zustand, not
 * TanStack Query. `use-lifecycle.ts` writes here when server
 * resolutions resolve (`active` / `self_hosted` / gateway-auth
 * short-circuit branches); every other consumer reads via atomic
 * selectors so each subscriber only re-renders when the id flips.
 *
 * If routes ever encode `:assistantId` as a path segment, this
 * store collapses to a `useParams` read.
 *
 * @see {@link https://zustand.docs.pmnd.rs/guides/auto-generating-selectors}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface AssistantSelectionState {
  activeAssistantId: string | null;
}

interface AssistantSelectionActions {
  /**
   * Set the active assistant id. Pass `null` to clear (used during
   * the retire-and-rehatch recovery path while we're waiting for the
   * replacement assistant's id to land).
   */
  setActiveAssistantId: (assistantId: string | null) => void;
}

type AssistantSelectionStore = AssistantSelectionState &
  AssistantSelectionActions;

const useAssistantSelectionStoreBase = create<AssistantSelectionStore>(
  (set) => ({
    activeAssistantId: null,
    setActiveAssistantId: (assistantId) =>
      set({ activeAssistantId: assistantId }),
  }),
);

export const useAssistantSelectionStore = createSelectors(
  useAssistantSelectionStoreBase,
);
