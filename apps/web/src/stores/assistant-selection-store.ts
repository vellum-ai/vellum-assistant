/**
 * Active-assistant selection.
 *
 * Holds the id of the assistant the user has currently selected (or
 * the daemon resolved during lifecycle hatch). This is **selection
 * state** — which assistant the app is acting on right now — not
 * server state, so it lives in Zustand rather than in TanStack
 * Query. The lifecycle hook writes here in response to server
 * resolutions (active / self-hosted / gateway-auth short-circuit
 * branches); cross-domain consumers read via atomic selectors so
 * each subscriber only re-renders when the id flips.
 *
 * Eventually URL-driven (the route pattern is `/assistant/...` and
 * a future change can promote `assistantId` to a path segment per
 * the assistant-page-data-lifecycle redesign), at which point this
 * store collapses to a one-way subscription onto the URL. Until
 * then it's the single source of truth for the selection.
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
