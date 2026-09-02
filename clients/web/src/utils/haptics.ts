import { isNativeIOS, isNativeMobile } from "@/runtime/platform-detection";

const runWhen = async (
  enabled: boolean,
  fire: () => Promise<void>,
): Promise<void> => {
  if (!enabled) {
    return;
  }
  try {
    await fire();
  } catch {
    // Best-effort: call sites fire-and-forget and must never see a rejection.
  }
};

const lightImpact = (enabled: boolean): Promise<void> =>
  runWhen(enabled, async () => {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Light });
  });

const light = (): Promise<void> => lightImpact(isNativeMobile());

/**
 * Thin haptic-feedback wrapper. The impacts run on both native mobile shells,
 * the notifications only on native iOS. The pull-to-refresh threshold is the
 * light impact under the name its call site reads by. The lazy imports keep the
 * plugin out of plain browser contexts.
 */
export const haptic = {
  light,
  medium: () =>
    runWhen(isNativeMobile(), async () => {
      const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
      await Haptics.impact({ style: ImpactStyle.Medium });
    }),
  success: () =>
    runWhen(isNativeIOS(), async () => {
      const { Haptics, NotificationType } = await import("@capacitor/haptics");
      await Haptics.notification({ type: NotificationType.Success });
    }),
  error: () =>
    runWhen(isNativeIOS(), async () => {
      const { Haptics, NotificationType } = await import("@capacitor/haptics");
      await Haptics.notification({ type: NotificationType.Error });
    }),
  refreshThreshold: light,
};
