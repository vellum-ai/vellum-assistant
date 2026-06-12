/**
 * Zustand store holding the observable voice-mode state.
 *
 * Voice mode is the *conversation loop* layered over single-utterance
 * live-voice sessions: while the mode is on, finishing a turn automatically
 * starts listening for the next one, and a barge-in reconnects straight into
 * listening. Web-app counterpart to the macOS `VoiceModeManager`
 * (`clients/macos/.../VoiceModeManager.swift`) — same five states.
 *
 * The {@link useVoiceMode} controller owns the loop and writes here through
 * the actions; UI subscribes via per-field selectors. The session-level
 * machine (connecting/transcribing/thinking/…) stays in `useLiveVoiceStore`;
 * this store is the coarser, user-facing mode: `off → idle → listening →
 * processing → speaking` (ticket LUM-1969).
 */

import { create } from "zustand";

import type { VoiceModeState } from "@/runtime/voice-state";

import { createSelectors } from "@/utils/create-selectors";

export type { VoiceModeState };

export interface VoiceModeStoreState {
  /** Current voice-mode phase; `off` when the mode is inactive. */
  state: VoiceModeState;
  /**
   * Failure that ended voice mode, surfaced after the mode turns off.
   * Cleared on the next activation.
   */
  error: string | null;
  /**
   * True when the mode turned itself off (conversation timeout or repeated
   * session failures) rather than by a user action — lets the UI hint why
   * the conversation stopped. Cleared on the next activation.
   */
  autoDeactivated: boolean;
}

export interface VoiceModeActions {
  setState: (state: VoiceModeState) => void;
  /** Turn off with a surfaced failure message. */
  fail: (message: string) => void;
  /** Turn off, marking whether the mode deactivated itself. */
  turnOff: (options?: { auto?: boolean }) => void;
  /** Reset to a clean `off` (clears error/autoDeactivated). */
  reset: () => void;
}

export type VoiceModeStore = VoiceModeStoreState & VoiceModeActions;

const INITIAL_STATE: VoiceModeStoreState = {
  state: "off",
  error: null,
  autoDeactivated: false,
};

const useVoiceModeStoreBase = create<VoiceModeStore>()((set) => ({
  ...INITIAL_STATE,

  setState: (state) => set({ state }),
  fail: (message) => set({ state: "off", error: message }),
  turnOff: (options) =>
    set({ state: "off", autoDeactivated: options?.auto ?? false }),
  reset: () => set({ ...INITIAL_STATE }),
}));

export const useVoiceModeStore = createSelectors(useVoiceModeStoreBase);
