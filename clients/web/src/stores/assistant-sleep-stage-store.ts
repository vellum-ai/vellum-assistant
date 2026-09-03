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
 * - `dismissed` / `dismissedAssistantId`: clicking the stage away hands the
 *   status back to the banner, for that assistant's current sleep only. The
 *   dismissal carries the assistant it was aimed at, so switching to another
 *   sleeping assistant draws its stage while a remount of the same one (a
 *   window crossing the mobile breakpoint moves the stage between
 *   `ChatLayout`'s branches) keeps the dismissal. In-memory and
 *   session-scoped like the low-balance banner's; the stage resets it as soon
 *   as the assistant is neither sleeping nor waking.
 *
 * - `forcedScene`: a dev override (`_vellumDebug.flags.forceSleepStage(...)`)
 *   that pins the stage to one scene so the animation can be watched without
 *   an assistant that will actually go to sleep. Null in every normal session.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

/**
 * Where the stage is in the sleep it is drawing. Declared here rather than
 * beside the view because the store carries the dev override, and
 * `src/stores/` may not import from a domain.
 */
export type SleepStageScene = "sleeping" | "waking" | "woke";
interface AssistantSleepStageState {
  visible: boolean;
  dismissed: boolean;
  dismissedAssistantId: string | null;
  forcedScene: SleepStageScene | null;
}

interface AssistantSleepStageActions {
  setVisible: (visible: boolean) => void;
  dismiss: (assistantId: string | null) => void;
  reset: () => void;
  setForcedScene: (scene: SleepStageScene | null) => void;
}

const useAssistantSleepStageStoreBase = create<
  AssistantSleepStageState & AssistantSleepStageActions
>()((set) => ({
  visible: false,
  dismissed: false,
  dismissedAssistantId: null,
  forcedScene: null,

  setVisible: (visible) => set({ visible }),
  dismiss: (assistantId) =>
    set({ dismissed: true, dismissedAssistantId: assistantId, visible: false }),
  reset: () => set({ dismissed: false, dismissedAssistantId: null }),
  setForcedScene: (forcedScene) => set({ forcedScene }),
}));

export const useAssistantSleepStageStore = createSelectors(
  useAssistantSleepStageStoreBase,
);
