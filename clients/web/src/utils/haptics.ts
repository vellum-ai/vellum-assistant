import { isNativeIOS } from "@/runtime/platform-detection";

const runIOS = async (fire: () => Promise<void>): Promise<void> => {
  if (!isNativeIOS()) {
    return;
  }
  try {
    await fire();
  } catch {
    // Best-effort: call sites fire-and-forget and must never see a rejection.
  }
};

/**
 * Thin haptic-feedback wrapper. On native Capacitor iOS this delegates to
 * `@capacitor/haptics`; on Android and web it's a no-op. The lazy import keeps
 * the plugin out of plain browser contexts.
 */
export const haptic = {
  light: () =>
    runIOS(async () => {
      const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
      await Haptics.impact({ style: ImpactStyle.Light });
    }),
  medium: () =>
    runIOS(async () => {
      const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
      await Haptics.impact({ style: ImpactStyle.Medium });
    }),
  success: () =>
    runIOS(async () => {
      const { Haptics, NotificationType } = await import("@capacitor/haptics");
      await Haptics.notification({ type: NotificationType.Success });
    }),
  error: () =>
    runIOS(async () => {
      const { Haptics, NotificationType } = await import("@capacitor/haptics");
      await Haptics.notification({ type: NotificationType.Error });
    }),
};
