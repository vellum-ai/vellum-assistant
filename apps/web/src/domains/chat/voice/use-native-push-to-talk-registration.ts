import { useEffect } from "react";

import { NONE_PTT_ACTIVATOR } from "@/utils/ptt-activator";
import {
  configureNativePushToTalk,
  getPushToTalkConfig,
  onPushToTalkConfigChange,
  supportsNativePushToTalk,
} from "@/runtime/hotkey";

export function useNativePushToTalkRegistration(): void {
  useEffect(() => {
    if (typeof window === "undefined" || !supportsNativePushToTalk()) {
      return;
    }

    let disposed = false;
    let syncInFlight: Promise<void> | null = null;
    let syncAgain = false;

    const sync = () => {
      if (syncInFlight) {
        syncAgain = true;
        return;
      }

      syncInFlight = (async () => {
        do {
          syncAgain = false;
          const config = await getPushToTalkConfig();
          if (!disposed) {
            await configureNativePushToTalk(config);
          }
        } while (!disposed && syncAgain);
      })().finally(() => {
        syncInFlight = null;
      });
    };

    sync();
    const unsubscribeSetting = onPushToTalkConfigChange(() => sync());

    return () => {
      disposed = true;
      unsubscribeSetting();
      void configureNativePushToTalk(NONE_PTT_ACTIVATOR);
    };
  }, []);
}
