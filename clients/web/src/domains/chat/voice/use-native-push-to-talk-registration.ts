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
  setNativePushToTalkActivator,
  supportsConfigurablePushToTalk,
  supportsFnPushToTalk,
  supportsNativePushToTalk,
} from "@/runtime/hotkey";

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
          if (!ok) {
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

    return () => {
      disposed = true;
      unsubscribeSetting();
      void (configurable
        ? setNativePushToTalkActivator(null)
        : setFnPushToTalkEnabled(false));
    };
  }, []);
}
