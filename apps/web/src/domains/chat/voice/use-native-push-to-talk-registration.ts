import { useEffect } from "react";

import { NONE_PTT_ACTIVATOR } from "@/utils/ptt-activator";
import {
  configureNativePushToTalk,
  getPushToTalkConfig,
  onPushToTalkConfigChange,
  supportsNativePushToTalk,
} from "@/runtime/hotkey";

let registrationGeneration = 0;

export function useNativePushToTalkRegistration(): void {
  useEffect(() => {
    if (typeof window === "undefined" || !supportsNativePushToTalk()) {
      return;
    }

    const generation = ++registrationGeneration;
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
          if (!disposed && registrationGeneration === generation) {
            await configureNativePushToTalk(config);
          }
        } while (
          !disposed &&
          registrationGeneration === generation &&
          syncAgain
        );
      })().finally(() => {
        syncInFlight = null;
      });
    };

    sync();
    const unsubscribeSetting = onPushToTalkConfigChange(() => sync());

    return () => {
      disposed = true;
      unsubscribeSetting();
      window.setTimeout(() => {
        if (registrationGeneration === generation) {
          void configureNativePushToTalk(NONE_PTT_ACTIVATOR);
        }
      }, 0);
    };
  }, []);
}
