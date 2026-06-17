/**
 * Focused-onboarding presentation flag.
 *
 * SPIKE — research-onboarding flow.
 *
 * Lives at top-level `stores/` (not `domains/onboarding/`) because it is read
 * by the `chat` domain (`ChatLayout`) and written by the `onboarding` domain;
 * cross-domain shared state belongs at the top level per CONVENTIONS.md.
 *
 * The research-onboarding front door (`/assistant/onboarding/research`) stages
 * a pre-chat context whose `initialMessage` is the "research me" prompt, then
 * hands off to the existing `/assistant?onboarding=1` pipeline. We want the
 * resulting chat to render in a distraction-free "focused" presentation (no
 * sidebar / header) until the user explicitly continues into their workspace.
 *
 * A URL query flag (`?focused=1`) can't carry that intent: the onboarding
 * orchestrator immediately `navigate(routes.conversation(draftId), {replace})`
 * to swap the draft id into the path, stripping any query param before
 * `ChatLayout` can read it (see `use-onboarding-orchestrator.ts`). A reactive
 * store flag, set before the handoff navigation, survives those internal
 * client-side redirects and is read by the persistent `ChatLayout`.
 *
 * Lifetime: `enterFocus()` on submit of the research form, `exitFocus()` when
 * the user clicks "Continue" out of the focused chat (or remounts the form).
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface OnboardingFocusState {
  /** When true, `ChatLayout` renders chrome-less with a Continue affordance. */
  focused: boolean;
  enterFocus: () => void;
  exitFocus: () => void;
  /**
   * A follow-up message the focused results overlay wants sent into the same
   * conversation (e.g. the "deeper dive" research request). The overlay lives
   * outside `ActiveChatView`, which owns `sendMessage`; ActiveChatView watches
   * this and sends it through the real pipeline, then clears it. Null when
   * nothing is pending.
   */
  pendingFollowupMessage: string | null;
  requestFollowup: (message: string) => void;
  clearFollowup: () => void;
}

const useOnboardingFocusStoreBase = create<OnboardingFocusState>((set) => ({
  focused: false,
  enterFocus: () => set({ focused: true }),
  exitFocus: () => set({ focused: false, pendingFollowupMessage: null }),
  pendingFollowupMessage: null,
  requestFollowup: (message) => set({ pendingFollowupMessage: message }),
  clearFollowup: () => set({ pendingFollowupMessage: null }),
}));

export const useOnboardingFocusStore = createSelectors(
  useOnboardingFocusStoreBase,
);
