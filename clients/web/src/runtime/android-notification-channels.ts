import { isNativeAndroid } from "@/runtime/platform-detection";

export const ANDROID_ALERTS_CHANNEL_ID = "vellum-alerts";

let channelPromise: Promise<void> | null = null;

export async function ensureAndroidAlertsChannel(): Promise<void> {
  if (!isNativeAndroid()) {
    return;
  }
  if (!channelPromise) {
    channelPromise = (async () => {
      const { LocalNotifications } =
        await import("@capacitor/local-notifications");
      await LocalNotifications.createChannel({
        id: ANDROID_ALERTS_CHANNEL_ID,
        name: "Alerts",
        importance: 3,
      });
    })().catch((error) => {
      channelPromise = null;
      throw error;
    });
  }
  await channelPromise;
}
