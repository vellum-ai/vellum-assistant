/**
 * State for the in-chat onboarding UI prototype, coordinating surfaces that
 * live in different places in the tree:
 *
 * - `prototypeActive` + `stage` drive the prototype itself: activating it
 *   starts the avatar tour immediately — the flow users will hit right
 *   after research onboarding, on their first sight of the app. The tour
 *   hides the chrome through its intro and reveals it beat by beat.
 * - `navTourActive` is raised by the tour for its flight's duration: the
 *   sidebar's assistant cluster reads it and fully suppresses its own avatar
 *   treatment (colored row, resting eyes, the New Chat visit flood) — two
 *   sets of eyes and two competing floods on the same rows read as a glitch.
 *
 * An app-level store keeps the chat and onboarding surfaces decoupled.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

export type InChatOnboardingStage = "tour" | "done";

interface InChatOnboardingState {
  prototypeActive: boolean;
  stage: InChatOnboardingStage;
  /** Bumped per tour start so the tour component remounts and replays. */
  tourRun: number;
  navTourActive: boolean;
  /** The tour reveals the sidebar itself (with a bounce) at its side-menu
   *  takeover beat — until then the chrome stays hidden through the intro. */
  tourSidebarRevealed: boolean;
}

interface InChatOnboardingActions {
  /** Starts (or replays) the tour immediately — there is no interim stage. */
  startPrototype: () => void;
  finishTour: () => void;
  setNavTourActive: (active: boolean) => void;
  setTourSidebarRevealed: (revealed: boolean) => void;
}

type InChatOnboardingStore = InChatOnboardingState & InChatOnboardingActions;

const useInChatOnboardingStoreBase = create<InChatOnboardingStore>((set) => ({
  prototypeActive: false,
  stage: "done",
  tourRun: 0,
  navTourActive: false,
  tourSidebarRevealed: false,
  startPrototype: () =>
    set((s) => ({
      prototypeActive: true,
      stage: "tour",
      tourRun: s.tourRun + 1,
      tourSidebarRevealed: false,
    })),
  finishTour: () => set({ prototypeActive: false, stage: "done" }),
  setNavTourActive: (active) => set({ navTourActive: active }),
  setTourSidebarRevealed: (revealed) =>
    set({ tourSidebarRevealed: revealed }),
}));

export const useInChatOnboardingStore = createSelectors(
  useInChatOnboardingStoreBase,
);

/** Whether the tour is running — every beat, intro through last stop. */
export function selectTourActive(state: InChatOnboardingStore): boolean {
  return state.prototypeActive && state.stage === "tour";
}

/** Whether the sidebar is hidden: the tour's opening beats, until the tour
 *  itself reveals it with a bounce. */
export function selectChatFocusActive(state: InChatOnboardingStore): boolean {
  return selectTourActive(state) && !state.tourSidebarRevealed;
}

/** Whether the header's center chat title is hidden — the ENTIRE tour: the
 *  walk's controls return with the sidebar, but a conversation title over
 *  the tour's narration reads as noise. */
export function selectHeaderCenterHidden(
  state: InChatOnboardingStore,
): boolean {
  return selectTourActive(state);
}

/** Whether the header's controls are hidden — the tour's opening beats;
 *  they return alongside the sidebar reveal, the chrome re-emerging piece
 *  by piece as the tour introduces it. */
export function selectHeaderControlsHidden(
  state: InChatOnboardingStore,
): boolean {
  return selectTourActive(state) && !state.tourSidebarRevealed;
}
