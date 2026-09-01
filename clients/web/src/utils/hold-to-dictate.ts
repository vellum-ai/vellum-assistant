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
