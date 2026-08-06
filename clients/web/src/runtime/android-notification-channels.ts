import { Capacitor, registerPlugin } from "@capacitor/core";

import { isNativeAndroid } from "@/runtime/platform-detection";

export const ANDROID_ALERTS_CHANNEL_ID = "vellum-alerts";
const ANDROID_NOTIFICATION_CHANNELS_PLUGIN = "AndroidNotificationChannels";

interface AndroidNotificationChannelsPlugin {
  ensureAlertsChannel(): Promise<void>;
}

const AndroidNotificationChannels =
  registerPlugin<AndroidNotificationChannelsPlugin>(
    ANDROID_NOTIFICATION_CHANNELS_PLUGIN,
  );

let channelPromise: Promise<void> | null = null;

export async function ensureAndroidAlertsChannel(): Promise<void> {
  if (!isNativeAndroid()) {
    return;
  }
  if (!Capacitor.isPluginAvailable(ANDROID_NOTIFICATION_CHANNELS_PLUGIN)) {
    return;
  }
  if (!channelPromise) {
    channelPromise = AndroidNotificationChannels.ensureAlertsChannel().catch(
      (error) => {
        channelPromise = null;
        throw error;
      },
    );
  }
  await channelPromise;
}
