import { Capacitor } from "@capacitor/core";

/**
 * Thin wrapper around `@capacitor/haptics` that is safe to import in any
 * environment (web, SSR, test). The Haptics plugin uses `registerPlugin()`
 * at module-load time which throws in contexts without the full Capacitor
 * runtime, so we lazy-import the plugin only when actually invoked on a
 * native platform.
 */
export const haptic = {
  light: async () => {
    if (!Capacitor.isNativePlatform()) return;
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Light });
  },
  medium: async () => {
    if (!Capacitor.isNativePlatform()) return;
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Medium });
  },
  success: async () => {
    if (!Capacitor.isNativePlatform()) return;
    const { Haptics, NotificationType } = await import("@capacitor/haptics");
    await Haptics.notification({ type: NotificationType.Success });
  },
  error: async () => {
    if (!Capacitor.isNativePlatform()) return;
    const { Haptics, NotificationType } = await import("@capacitor/haptics");
    await Haptics.notification({ type: NotificationType.Error });
  },
};
