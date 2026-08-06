/**
 * Doctor hand-off state — a one-shot inbox the chat `/doctor <message>`
 * slash command writes to and the Doctor panel reads from on load.
 *
 * Why a store instead of a query param: the first message is arbitrary
 * user-authored text. Carrying it in the URL would place it in browser
 * history and in navigation breadcrumbs captured by telemetry. An
 * in-memory hand-off keeps the prompt out of the URL entirely; the chat
 * sender parks it here and navigates to the Doctor tab, and the Doctor
 * panel consumes it once mounted to auto-start a session and send it.
 *
 * One-shot semantics — `consumePendingDoctorPrompt` returns and clears.
 * If a second `/doctor` is submitted before consumption, the latest
 * prompt wins (silent overwrite). Renderer reloads / hard navigates blow
 * this away because it's not persisted — by design, the hand-off is a
 * transient signal.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

export interface DoctorHandoffState {
  /** Latest pending `/doctor` first message, or `null` if none. */
  pendingPrompt: string | null;
}

export interface DoctorHandoffActions {
  /**
   * Park the first message the Doctor panel should send once its
   * auto-started session is active. Overwrites any pending prompt.
   */
  setPendingPrompt: (prompt: string) => void;
  /**
   * Read and clear the pending prompt. Returns `null` if none was set.
   */
  consumePendingPrompt: () => string | null;
}

export type DoctorHandoffStore = DoctorHandoffState & DoctorHandoffActions;

const useDoctorHandoffStoreBase = create<DoctorHandoffStore>()((set, get) => ({
  pendingPrompt: null,
  setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),
  consumePendingPrompt: () => {
    const prompt = get().pendingPrompt;
    if (prompt !== null) {
      set({ pendingPrompt: null });
    }
    return prompt;
  },
}));

export const useDoctorHandoffStore = createSelectors(useDoctorHandoffStoreBase);

/**
 * Reset hook for tests. Not intended for production callers.
 */
export function __resetDoctorHandoffForTesting(): void {
  useDoctorHandoffStoreBase.setState({ pendingPrompt: null });
}
