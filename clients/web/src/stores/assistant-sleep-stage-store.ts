import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * Zustand store shared by the full-page sleep stage (`AssistantSleepStage`,
 * mounted over the conversation page) and the `StatusBanner`.
 *
 * Two facts live here because the two surfaces that need them sit in
 * different subtrees:
 *
 * - `visible`: the stage tells the banner it is on screen, so the banner
 *   drops its sleeping/waking notice rather than saying the same thing twice.
 * - `dismissed`: clicking the stage away hands the status back to the
 *   banner. In-memory and session-scoped like the low-balance banner's
 *   dismissal; the stage resets it as soon as the assistant is neither
 *   sleeping nor waking, so the next sleep shows the stage again.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */
interface AssistantSleepStageState {
  visible: boolean;
  dismissed: boolean;
}

interface AssistantSleepStageActions {
  setVisible: (visible: boolean) => void;
  dismiss: () => void;
  reset: () => void;
}

const useAssistantSleepStageStoreBase = create<
  AssistantSleepStageState & AssistantSleepStageActions
>()((set) => ({
  visible: false,
  dismissed: false,

  setVisible: (visible) => set({ visible }),
  dismiss: () => set({ dismissed: true, visible: false }),
  reset: () => set({ dismissed: false }),
}));

export const useAssistantSleepStageStore = createSelectors(
  useAssistantSleepStageStoreBase,
);
