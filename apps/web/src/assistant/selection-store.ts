/**
 * Active-assistant selection.
 *
 * Single source of truth for "which assistant is the app acting on
 * right now." Selection state — not server state — so it lives in
 * Zustand, not in TanStack Query. `use-lifecycle.ts` writes here in
 * response to server resolutions (`active` / `self_hosted` /
 * gateway-auth short-circuit branches); every other consumer reads
 * via atomic selectors so each subscriber only re-renders when the
 * id flips.
 *
 * Sits next to `lifecycle-store.ts` and `queries.ts` rather than
 * under `src/stores/` because the assistant domain owns the
 * selection concept — selection only changes via lifecycle
 * transitions, and keeping the writer and reader in the same folder
 * makes the data flow obvious to the next reader.
 *
 * Once routes encode `:assistantId` as a path segment, this store
 * collapses to a `useParams` read — until then it's the canonical
 * selection.
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
