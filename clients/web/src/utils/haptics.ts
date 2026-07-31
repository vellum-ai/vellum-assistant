import { isNativePlatform } from "@/runtime/native-auth";

const runNative = async (fire: () => Promise<void>): Promise<void> => {
  if (!isNativePlatform()) {
    return;
  }
  try {
    await fire();
  } catch {
    // Best-effort: call sites fire-and-forget and must never see a rejection.
  }
};

/**
 * Thin haptic-feedback wrapper. On native Capacitor platforms this delegates
 * to `@capacitor/haptics`; on web it's a no-op. The lazy import ensures the
 * Capacitor plugin's `registerPlugin()` call (which throws without the full
 * runtime) never runs in a plain browser context.
 */
export const haptic = {
  light: () =>
    runNative(async () => {
      const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
      await Haptics.impact({ style: ImpactStyle.Light });
    }),
  medium: () =>
    runNative(async () => {
      const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
      await Haptics.impact({ style: ImpactStyle.Medium });
    }),
  success: () =>
    runNative(async () => {
      const { Haptics, NotificationType } = await import("@capacitor/haptics");
      await Haptics.notification({ type: NotificationType.Success });
    }),
  error: () =>
    runNative(async () => {
      const { Haptics, NotificationType } = await import("@capacitor/haptics");
      await Haptics.notification({ type: NotificationType.Error });
    }),
};
