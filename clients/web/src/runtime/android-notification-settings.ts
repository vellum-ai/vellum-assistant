import { Capacitor, registerPlugin } from "@capacitor/core";

import { captureError } from "@/lib/sentry/capture-error";
import { isNativeAndroid } from "@/runtime/platform-detection";

const AndroidNotificationSettings = registerPlugin<{ open(): Promise<void> }>("AndroidNotificationSettings");

export function isAndroidNotificationSettingsAvailable(): boolean {
  return isNativeAndroid() && Capacitor.isPluginAvailable("AndroidNotificationSettings");
}

export async function openAndroidNotificationSettings(): Promise<void> {
  if (!isAndroidNotificationSettingsAvailable()) {
    return;
  }
  try {
    await AndroidNotificationSettings.open();
  } catch (error) {
    captureError(error, { context: "android_notification_settings_open", level: "warning" });
  }
}
