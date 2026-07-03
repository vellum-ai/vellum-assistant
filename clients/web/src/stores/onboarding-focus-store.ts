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
 * Avatar traits are handoff state and clear through their own setter.
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { CharacterTraits } from "@/types/avatar";

interface OnboardingFocusState {
  /** When true, `ChatLayout` renders chrome-less with a Continue affordance. */
  focused: boolean;
  enterFocus: () => void;
  exitFocus: () => void;
  /**
   * Avatar traits chosen on the "Give me a face" picker, staged at handoff and
   * applied to the assistant once it's hatched (the avatar isn't part of the
   * pre-chat context, so it's a post-hatch call). Cleared after a successful
   * apply or when a new research-onboarding form mounts.
   */
  pendingAvatarTraits: CharacterTraits | null;
  setPendingAvatarTraits: (traits: CharacterTraits | null) => void;
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
  /**
   * When true, the focused overlay shows the "Let's chat tomorrow" Google
   * Calendar step INSTEAD of the research results — while the research pass
   * streams in behind it (the pipeline auto-sends on handoff). Cleared once the
   * user connects or skips, revealing the (by then usually ready) results.
   * `checkinUserName` carries the collected name through to the Day-2 Check-in
   * prompt, since the pre-chat context is consumed by the research send before
   * the user reaches this step.
   */
  checkinPending: boolean;
  checkinUserName: string | null;
  beginCheckin: (userName?: string) => void;
  endCheckin: () => void;
  /**
   * Set by the onboarding handoff so the chat side panel opens collapsed for a
   * focused first impression; consumed (cleared) once by `ChatLayout`. The
   * signal is one-shot — set once at handoff and consumed on the next
   * `ChatLayout` mount; honoring it flips the chat's ordinary persisted
   * `collapsed` state, so the user lands collapsed and it remains their default
   * until they expand it.
   */
  sidebarCollapseRequested: boolean;
  requestSidebarCollapse: () => void;
  consumeSidebarCollapse: () => void;
  /**
   * Set by the onboarding orchestrator when the user lands in chat after
   * completing the onboarding funnel. ChatLayout reads this to suppress the
   * back/forward history arrows so users can't navigate back to onboarding
   * screens (the browser history stack still contains those entries, but the
   * UI won't offer a way to reach them). Cleared on the first real PUSH
   * navigation (opening a different conversation, navigating to settings,
   * etc.) so normal history tracking resumes.
   */
  justCompletedOnboarding: boolean;
  setJustCompletedOnboarding: () => void;
  clearJustCompletedOnboarding: () => void;
}

const useOnboardingFocusStoreBase = create<OnboardingFocusState>((set) => ({
  focused: false,
  enterFocus: () => set({ focused: true }),
  exitFocus: () =>
    set({
      focused: false,
      pendingFollowupMessage: null,
      checkinPending: false,
      sidebarCollapseRequested: false,
      justCompletedOnboarding: false,
    }),
  pendingAvatarTraits: null,
  setPendingAvatarTraits: (traits) => set({ pendingAvatarTraits: traits }),
  pendingFollowupMessage: null,
  requestFollowup: (message) => set({ pendingFollowupMessage: message }),
  clearFollowup: () => set({ pendingFollowupMessage: null }),
  checkinPending: false,
  checkinUserName: null,
  beginCheckin: (userName) =>
    set({ checkinPending: true, checkinUserName: userName ?? null }),
  endCheckin: () => set({ checkinPending: false }),
  sidebarCollapseRequested: false,
  requestSidebarCollapse: () => set({ sidebarCollapseRequested: true }),
  consumeSidebarCollapse: () => set({ sidebarCollapseRequested: false }),
  justCompletedOnboarding: false,
  setJustCompletedOnboarding: () => set({ justCompletedOnboarding: true }),
  clearJustCompletedOnboarding: () => set({ justCompletedOnboarding: false }),
}));

export const useOnboardingFocusStore = createSelectors(
  useOnboardingFocusStoreBase,
);
