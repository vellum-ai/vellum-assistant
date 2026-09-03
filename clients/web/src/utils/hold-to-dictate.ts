import { useEffect, useState } from "react";

import {
  getLocalSetting,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";

/**
 * Whether dictation is bound to a held modifier set.
 *
 * Off until asked for, because arming it costs the user an Input Monitoring
 * grant: a binding nobody switched on should not be the reason macOS asks to
 * watch their keyboard.
 *
 * Shared rather than owned by either side. Settings offers the switch and chat
 * runs the binding, and a domain reaching across for it is the thing the
 * boundary exists to stop.
 */
export const LS_HOLD_TO_DICTATE = "vellum:voice:holdToDictate";

export function readHoldToDictateEnabled(): boolean {
  return getLocalSetting(LS_HOLD_TO_DICTATE, "") === "true";
}

export function setHoldToDictateEnabled(enabled: boolean): void {
  setLocalSetting(LS_HOLD_TO_DICTATE, enabled ? "true" : "false");
}

/** Subscribe to the setting, including changes made in another window. */
export function useHoldToDictateEnabled(): boolean {
  const [enabled, setEnabled] = useState(readHoldToDictateEnabled);
  useEffect(
    () =>
      watchSetting(LS_HOLD_TO_DICTATE, () => {
        setEnabled(readHoldToDictateEnabled());
      }),
    [],
  );
  return enabled;
}

/**
 * Whether the dictation being recorded was started by the held keys.
 *
 * A hold is aimed at a cursor in another application and shows its words on
 * the companion while they are said, so what it owes the user is the sentence
 * they just read, as soon as they stop. That is a different bargain from the
 * composer's microphone, which can afford to wait for the best answer because
 * nobody is standing in another app watching for it.
 *
 * A flag rather than a parameter because the recording is started through an
 * imperative handle on whichever `VoiceInputButton` currently owns dictation,
 * which is the composer's on a chat route and a headless one everywhere else.
 * Read once when a session starts, so what it says later cannot change the
 * bargain a session was begun under.
 */
let holdDictation = false;

export function markHoldDictation(active: boolean): void {
  holdDictation = active;
}

export function isHoldDictation(): boolean {
  return holdDictation;
}
