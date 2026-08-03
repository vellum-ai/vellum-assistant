import { registerPlugin } from "@capacitor/core";

import { captureError } from "@/lib/sentry/capture-error";
import { isNativeAndroid } from "@/runtime/platform-detection";

const AndroidNotificationSettings = registerPlugin<{ open(): Promise<void> }>("AndroidNotificationSettings");

export async function openAndroidNotificationSettings(): Promise<void> {
  if (!isNativeAndroid()) {
    return;
  }
  try {
    await AndroidNotificationSettings.open();
  } catch (error) {
    captureError(error, { context: "android_notification_settings_open", level: "warning" });
  }
}
