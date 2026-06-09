import { useEffect } from "react";

import {
  FN_PTT_ACTIVATOR,
  LS_PTT_ACTIVATION_KEY,
  isFnPushToTalkActivator,
  parseActivator,
} from "@/utils/ptt-activator";
import { getLocalSetting, watchSetting } from "@/utils/local-settings";
import {
  setFnPushToTalkEnabled,
  supportsFnPushToTalk,
} from "@/runtime/hotkey";

function shouldRegisterFnPushToTalk(): boolean {
  const raw = getLocalSetting(LS_PTT_ACTIVATION_KEY, "");
  const activator = raw
    ? parseActivator(raw, { preserveFunction: true })
    : FN_PTT_ACTIVATOR;
  return isFnPushToTalkActivator(activator);
}

export function useNativePushToTalkRegistration(): void {
  useEffect(() => {
    if (typeof window === "undefined" || !supportsFnPushToTalk()) {
      return;
    }

    let disposed = false;
    let desired = shouldRegisterFnPushToTalk();
    let applied = false;
    let syncInFlight: Promise<void> | null = null;

    const sync = () => {
      if (syncInFlight) return;

      syncInFlight = (async () => {
        while (!disposed && applied !== desired) {
          const next = desired;
          const ok = await setFnPushToTalkEnabled(next);
          if (!ok) {
            if (next) applied = false;
            return;
          }
          applied = next;
        }
      })().finally(() => {
        syncInFlight = null;
      });
    };

    const updateDesiredRegistration = () => {
      desired = shouldRegisterFnPushToTalk();
      sync();
    };

    updateDesiredRegistration();
    const unsubscribeSetting = watchSetting(
      LS_PTT_ACTIVATION_KEY,
      updateDesiredRegistration,
    );

    return () => {
      disposed = true;
      unsubscribeSetting();
      if (applied || desired) {
        void setFnPushToTalkEnabled(false);
      }
    };
  }, []);
}
