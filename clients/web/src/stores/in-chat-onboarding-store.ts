/**
 * State for the in-chat onboarding UI prototype, coordinating three surfaces
 * that live in different places in the tree:
 *
 * - `prototypeActive` + `stage` drive the prototype itself: while the stage
 *   is `chat`, `ChatLayout` hides the sidebar and the header's controls so
 *   the real conversation UI reads as a focused, chat-only takeover. Moving
 *   to `tour` reveals the chrome and runs the avatar tour.
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

export type InChatOnboardingStage = "chat" | "tour" | "done";

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
  startPrototype: () => void;
  exitPrototype: () => void;
  showFocusedChat: () => void;
  startTourStage: () => void;
  finishTour: () => void;
  setNavTourActive: (active: boolean) => void;
  setTourSidebarRevealed: (revealed: boolean) => void;
}

type InChatOnboardingStore = InChatOnboardingState & InChatOnboardingActions;

const useInChatOnboardingStoreBase = create<InChatOnboardingStore>((set) => ({
  prototypeActive: false,
  stage: "chat",
  tourRun: 0,
  navTourActive: false,
  tourSidebarRevealed: false,
  startPrototype: () => set({ prototypeActive: true, stage: "chat" }),
  exitPrototype: () => set({ prototypeActive: false, stage: "chat" }),
  showFocusedChat: () => set({ stage: "chat", tourSidebarRevealed: false }),
  startTourStage: () =>
    set((s) => ({
      stage: "tour",
      tourRun: s.tourRun + 1,
      tourSidebarRevealed: false,
    })),
  finishTour: () => set({ stage: "done" }),
  setNavTourActive: (active) => set({ navTourActive: active }),
  setTourSidebarRevealed: (revealed) =>
    set({ tourSidebarRevealed: revealed }),
}));

export const useInChatOnboardingStore = createSelectors(
  useInChatOnboardingStoreBase,
);

/** Whether the sidebar is hidden: the focused chat-only stage, plus the
 *  tour's opening beats until the tour itself reveals it. */
export function selectChatFocusActive(state: InChatOnboardingStore): boolean {
  if (!state.prototypeActive) {
    return false;
  }
  if (state.stage === "chat") {
    return true;
  }
  return state.stage === "tour" && !state.tourSidebarRevealed;
}

/** Whether the header's controls are hidden — the focused stage AND the
 *  entire tour (the tour reveals the sidebar mid-way but the top nav stays
 *  bare until it finishes). */
export function selectHeaderControlsHidden(
  state: InChatOnboardingStore,
): boolean {
  return (
    state.prototypeActive &&
    (state.stage === "chat" || state.stage === "tour")
  );
}
