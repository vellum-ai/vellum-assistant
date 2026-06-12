import {
  VOICE_MODE_STATES,
  type VoiceModeState,
  voiceModeStateSchema,
} from "@vellumai/ipc-contract";
import { z } from "zod";

import { on } from "./ipc";

/**
 * Voice mode state published by the renderer over `vellum:voice:state`.
 *
 * The renderer owns the voice-mode state machine (it holds the audio context
 * and the mic input, so transitions fire locally without a main-process round
 * trip — see the LUM-1969 design); main only mirrors the latest state for
 * presentation, the same split `status.ts` uses for the assistant connection
 * status. The tray subscribes to show "listening / thinking / speaking" in
 * its tooltip and menu header while a voice conversation is active.
 */
export { VOICE_MODE_STATES, type VoiceModeState };

/**
 * Tray tooltip / menu-header line for an active voice conversation, or `null`
 * when voice mode is inactive (`off`) and the regular assistant status line
 * should be shown instead. Mirrors the Swift `VoiceModeManager.stateLabel`
 * wording.
 */
export const voiceMenuTitle = (
  state: VoiceModeState,
  assistantName?: string,
): string | null => {
  const name = assistantName ?? "Assistant";
  switch (state) {
    case "off":
      return null;
    case "idle":
      return `${name} — voice mode ready`;
    case "listening":
      return `${name} is listening…`;
    case "processing":
      return `${name} is thinking…`;
    case "speaking":
      return `${name} is speaking…`;
  }
};

type VoiceStateListener = (state: VoiceModeState) => void;

let currentVoiceState: VoiceModeState = "off";
const listeners = new Set<VoiceStateListener>();

export const getVoiceState = (): VoiceModeState => currentVoiceState;

/**
 * Subscribe to voice-state transitions. Returns an unsubscribe function.
 * Invoked only on an actual change (the setter de-dupes), so subscribers
 * never rebuild tray presentation for a no-op republish.
 */
export const onVoiceStateChange = (
  listener: VoiceStateListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const setVoiceState = (state: VoiceModeState): void => {
  if (state === currentVoiceState) return;
  currentVoiceState = state;
  for (const listener of listeners) listener(state);
};

const voiceStatePayloadSchema = z.tuple([voiceModeStateSchema]);

/**
 * Register the `vellum:voice:state` renderer→main channel. Fire-and-forget
 * (`ipcRenderer.send`), matching `vellum:status:connection`: a state
 * republish has no return value and a malformed payload drops silently.
 * Call once from `whenReady`.
 */
let installed = false;
export const installVoiceStateIpc = (): void => {
  if (installed) return;
  installed = true;

  on("vellum:voice:state", voiceStatePayloadSchema, ([state]) => {
    setVoiceState(state);
  });
};

// Test seam — exported only for unit-test setup so each test starts from a
// known state. Production code never calls this.
export const __resetForTesting = (): void => {
  installed = false;
  currentVoiceState = "off";
  listeners.clear();
};
