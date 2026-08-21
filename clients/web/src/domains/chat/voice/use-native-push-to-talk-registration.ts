import { useEffect } from "react";

import {
  pushToTalkActivation,
  serializeActivator,
  type PTTActivator,
} from "@/utils/ptt-activator";
import {
  setConfigurablePushToTalkActive,
  setNativePushToTalkActivator,
  supportsConfigurablePushToTalk,
  subscribeToPushToTalkRegistration,
} from "@/runtime/hotkey";
import { isPopoutWindow } from "@/runtime/popout-window";

export function useNativePushToTalkRegistration(): void {
  useEffect(() => {
    if (typeof window === "undefined" || !supportsConfigurablePushToTalk()) {
      return;
    }

    // The main window owns the global binding; a popout only suppresses its
    // own focused-window fallback so the two never race.
    if (isPopoutWindow(window.location.search)) {
      setConfigurablePushToTalkActive(true);
      return () => setConfigurablePushToTalkActive(false);
    }
    let disposed = false;
    let desired = pushToTalkActivation.load();
    let appliedKey: string | null = null;
    let syncInFlight: Promise<void> | null = null;

    const apply = (activator: PTTActivator) =>
      setNativePushToTalkActivator(activator.kind === "off" ? null : activator);

    const sync = () => {
      if (syncInFlight) {
        return;
      }

      syncInFlight = (async () => {
        while (!disposed) {
          const next = desired;
          const nextKey = serializeActivator(next);
          if (appliedKey === nextKey) {
            return;
          }
          const ok = await apply(next);
          setConfigurablePushToTalkActive(ok && next.kind !== "off");
          if (!ok) {
            appliedKey = null;
            if (serializeActivator(desired) !== nextKey) {
              continue;
            }
            return;
          }
          appliedKey = nextKey;
        }
      })().finally(() => {
        syncInFlight = null;
      });
    };

    const updateDesiredRegistration = () => {
      desired = pushToTalkActivation.load();
      sync();
    };

    updateDesiredRegistration();
    const unsubscribeSetting = pushToTalkActivation.subscribe(
      updateDesiredRegistration,
    );
    const unsubscribeRegistration = subscribeToPushToTalkRegistration(
      setConfigurablePushToTalkActive,
    );

    return () => {
      disposed = true;
      setConfigurablePushToTalkActive(false);
      unsubscribeSetting();
      unsubscribeRegistration();
      void setNativePushToTalkActivator(null);
    };
  }, []);
}
