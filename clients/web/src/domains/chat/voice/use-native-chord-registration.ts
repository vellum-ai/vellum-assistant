import { useEffect } from "react";

import type { VoiceModeChord } from "@vellumai/ipc-contract";

import {
  setNativeVoiceModeChord,
  subscribeToVoiceModeChordRegistration,
  supportsVoiceModeChord,
} from "@/runtime/hotkey";
import { watchSetting } from "@/utils/local-settings";

/**
 * Keeps the host helper's global chord registered for exactly as long as the
 * voice mode binding wants it. The Windows counterpart of
 * `useVoiceKey`: an Electron `globalShortcut` cannot express a
 * bare-modifier chord, so the helper's keyboard hook watches it system-wide
 * and reports a completed tap over the hotkey bridge.
 *
 * Registration is a request to the host and can fail (no helper, hook refused,
 * or a window that does not own the global binding), so the effect drives the
 * same sync loop as the Fn hook: re-apply until the applied binding matches
 * the desired one, and never leave a binding registered past the mount.
 *
 * `desiredActivator` is re-read whenever `settingKey` changes in localStorage,
 * so a binding edited in settings takes effect without a reload.
 *
 * `onRegistered` reports whether native capture is actually live; while it is,
 * the caller's focused-window DOM fallback stays quiet so a tap never fires
 * twice. The host restores the binding itself across helper restarts; a
 * registration it reports lost is forgotten here so the next setting change
 * re-applies it.
 */
export function useNativeChordRegistration(
  desiredActivator: () => VoiceModeChord | null,
  settingKey: string,
  onRegistered: (registered: boolean) => void,
): void {
  useEffect(() => {
    if (typeof window === "undefined" || !supportsVoiceModeChord()) {
      return;
    }

    const NOTHING = JSON.stringify(null);
    let disposed = false;
    let desired = desiredActivator();
    let appliedKey: string | null = NOTHING;
    let syncInFlight: Promise<void> | null = null;

    const sync = () => {
      if (syncInFlight) {
        return;
      }

      syncInFlight = (async () => {
        while (!disposed) {
          const next = desired;
          const nextKey = JSON.stringify(next);
          if (appliedKey === nextKey) {
            return;
          }
          const ok = await setNativeVoiceModeChord(next);
          if (!ok) {
            appliedKey = null;
            onRegistered(false);
            if (JSON.stringify(desired) !== nextKey) {
              continue;
            }
            return;
          }
          appliedKey = nextKey;
          onRegistered(next !== null);
        }
      })().finally(() => {
        syncInFlight = null;
      });
    };

    const updateDesiredRegistration = () => {
      desired = desiredActivator();
      sync();
    };

    updateDesiredRegistration();
    const unsubscribeSetting = watchSetting(
      settingKey,
      updateDesiredRegistration,
    );
    const unsubscribeRegistration = subscribeToVoiceModeChordRegistration(
      (active) => {
        if (!active) {
          appliedKey = null;
        }
        onRegistered(active);
      },
    );

    return () => {
      disposed = true;
      unsubscribeSetting();
      unsubscribeRegistration();
      onRegistered(false);
      if (appliedKey !== NOTHING) {
        void setNativeVoiceModeChord(null);
      }
    };
  }, [desiredActivator, settingKey, onRegistered]);
}
