import { useEffect } from "react";

import { setFnPushToTalkEnabled, supportsFnPushToTalk } from "@/runtime/hotkey";
import { watchSetting } from "@/utils/local-settings";

/**
 * Keeps the host helper's Fn listener registered for exactly as long as the
 * feature bound to Fn wants it.
 *
 * Browsers cannot observe Fn at all, so the desktop helper watches it for us
 * and reports `down` / `up` over the hotkey bridge. Registration is a request
 * to the host and can fail (the helper needs Input Monitoring), so the effect
 * drives a small sync loop: it re-applies until the applied state matches the
 * desired one, and never leaves the listener running past the mount or past
 * the feature turning it off.
 *
 * `shouldRegister` is re-read whenever `settingKey` changes in localStorage,
 * so a binding edited in settings takes effect without a reload.
 *
 * `onRegistered` reports whether the listener is actually running: false when
 * the host refuses (no helper, or Input Monitoring ungranted), which is the
 * caller's cue that a binding depending on Fn will never fire. A host with no
 * bridge at all reports nothing, since it never claimed Fn in the first place.
 */
export function useNativeFnRegistration(
  shouldRegister: () => boolean,
  settingKey: string,
  onRegistered?: (registered: boolean) => void,
): void {
  useEffect(() => {
    if (typeof window === "undefined" || !supportsFnPushToTalk()) {
      return;
    }

    let disposed = false;
    let desired = shouldRegister();
    let applied = false;
    let syncInFlight: Promise<void> | null = null;

    const sync = () => {
      if (syncInFlight) {
        return;
      }

      syncInFlight = (async () => {
        while (!disposed && applied !== desired) {
          const next = desired;
          const ok = await setFnPushToTalkEnabled(next);
          if (!ok) {
            if (next) {
              applied = false;
              onRegistered?.(false);
            }
            return;
          }
          applied = next;
          if (next) {
            onRegistered?.(true);
          }
        }
      })().finally(() => {
        syncInFlight = null;
      });
    };

    const updateDesiredRegistration = () => {
      desired = shouldRegister();
      sync();
    };

    updateDesiredRegistration();
    const unsubscribeSetting = watchSetting(
      settingKey,
      updateDesiredRegistration,
    );

    return () => {
      disposed = true;
      unsubscribeSetting();
      if (applied || desired) {
        void setFnPushToTalkEnabled(false);
      }
    };
  }, [shouldRegister, settingKey, onRegistered]);
}
