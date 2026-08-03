import { registerPlugin } from "@capacitor/core";

import { captureError } from "@/lib/sentry/capture-error";
import { isNativeAndroid } from "@/runtime/platform-detection";

interface AndroidNotificationSettingsPlugin {
  open(): Promise<void>;
}

const AndroidNotificationSettings =
  registerPlugin<AndroidNotificationSettingsPlugin>(
    "AndroidNotificationSettings",
  );

export async function openAndroidNotificationSettings(): Promise<boolean> {
  if (!isNativeAndroid()) {
    return false;
  }
  try {
    await AndroidNotificationSettings.open();
    return true;
  } catch (error) {
    captureError(error, {
      context: "android_notification_settings_open",
      level: "warning",
    });
    return false;
  }
}
