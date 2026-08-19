import { useEffect } from "react";

import {
  FN_PTT_ACTIVATOR,
  LS_PTT_ACTIVATION_KEY,
  isFnPushToTalkActivator,
  parseActivator,
  serializeActivator,
  type PTTActivator,
} from "@/utils/ptt-activator";
import { getLocalSetting, watchSetting } from "@/utils/local-settings";
import {
  setFnPushToTalkEnabled,
  setConfigurablePushToTalkActive,
  setNativePushToTalkActivator,
  supportsConfigurablePushToTalk,
  supportsFnPushToTalk,
  supportsNativePushToTalk,
  subscribeToPushToTalkRegistration,
} from "@/runtime/hotkey";
import { isPopoutWindow } from "@/runtime/popout-window";

function desiredActivator(fnAvailable: boolean): PTTActivator {
  const raw = getLocalSetting(LS_PTT_ACTIVATION_KEY, "");
  return raw
    ? parseActivator(raw, { preserveFunction: fnAvailable })
    : fnAvailable
      ? FN_PTT_ACTIVATOR
      : { kind: "off" };
}

export function useNativePushToTalkRegistration(): void {
  useEffect(() => {
    if (typeof window === "undefined" || !supportsNativePushToTalk()) {
      return;
    }

    const configurable = supportsConfigurablePushToTalk();
    if (configurable && isPopoutWindow(window.location.search)) {
      setConfigurablePushToTalkActive(true);
      return () => setConfigurablePushToTalkActive(false);
    }
    const fnAvailable = supportsFnPushToTalk();
    let disposed = false;
    let desired = desiredActivator(fnAvailable);
    let appliedKey: string | null = null;
    let syncInFlight: Promise<void> | null = null;

    const apply = async (activator: PTTActivator): Promise<boolean> => {
      if (configurable) {
        return setNativePushToTalkActivator(
          activator.kind === "off" ? null : activator,
        );
      }
      return setFnPushToTalkEnabled(
        fnAvailable && isFnPushToTalkActivator(activator),
      );
    };

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
          if (configurable) {
            setConfigurablePushToTalkActive(ok && next.kind !== "off");
          }
          if (!ok) {
            appliedKey = null;
            return;
          }
          appliedKey = nextKey;
        }
      })().finally(() => {
        syncInFlight = null;
      });
    };

    const updateDesiredRegistration = () => {
      desired = desiredActivator(fnAvailable);
      sync();
    };

    updateDesiredRegistration();
    const unsubscribeSetting = watchSetting(
      LS_PTT_ACTIVATION_KEY,
      updateDesiredRegistration,
    );
    const unsubscribeRegistration = configurable
      ? subscribeToPushToTalkRegistration(setConfigurablePushToTalkActive)
      : () => undefined;

    return () => {
      disposed = true;
      setConfigurablePushToTalkActive(false);
      unsubscribeSetting();
      unsubscribeRegistration();
      void (configurable
        ? setNativePushToTalkActivator(null)
        : setFnPushToTalkEnabled(false));
    };
  }, []);
}
