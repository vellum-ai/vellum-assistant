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
 * Thin haptic-feedback wrapper. The lazy imports keep the plugin out of plain
 * browser contexts.
 *
 * The light impact runs on both native mobile shells. Everything else runs on
 * native iOS only, and the split is deliberate rather than an omission: a
 * gesture is usually reported by a light impact on the way in and a heavier one
 * on the way out (the pull to refresh crosses its threshold on `light` and
 * finishes on `medium` or a notification), so widening the second half would
 * make one gesture buzz an Android device twice.
 *
 * The pull-to-refresh threshold is the light impact under the name its call
 * site reads by.
 */
export const haptic = {
  light,
  medium: () =>
    runWhen(isNativeIOS(), async () => {
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
