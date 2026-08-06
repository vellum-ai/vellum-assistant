import { Capacitor, registerPlugin } from "@capacitor/core";

import { captureError } from "@/lib/sentry/capture-error";
import type { ThemePreference } from "@/utils/theme-preferences";

type NativeLaunchTheme = "system" | "light" | "dark";

interface NativeLaunchScreenPlugin {
  ready(options: { theme: NativeLaunchTheme }): Promise<void>;
  setTheme(options: { theme: NativeLaunchTheme }): Promise<void>;
}

const NATIVE_LAUNCH_SCREEN_PLUGIN = "NativeLaunchScreen";
const NativeLaunchScreen =
  registerPlugin<NativeLaunchScreenPlugin>(NATIVE_LAUNCH_SCREEN_PLUGIN);

function nativeLaunchTheme(theme: ThemePreference): NativeLaunchTheme {
  return theme === "velvet" ? "dark" : theme;
}

function isAvailable(): boolean {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === "android" &&
    Capacitor.isPluginAvailable(NATIVE_LAUNCH_SCREEN_PLUGIN)
  );
}

/** Stores the active theme and releases the Android launch screen. */
export async function markNativeLaunchScreenReady(
  theme: ThemePreference,
): Promise<void> {
  if (!isAvailable()) {
    return;
  }
  try {
    await NativeLaunchScreen.ready({ theme: nativeLaunchTheme(theme) });
  } catch (error) {
    captureError(error, {
      context: "native_launch_screen_ready",
      bestEffort: true,
    });
  }
}

/** Keeps the next Android launch screen aligned with the app preference. */
export async function syncNativeLaunchScreenTheme(
  theme: ThemePreference,
): Promise<void> {
  if (!isAvailable()) {
    return;
  }
  try {
    await NativeLaunchScreen.setTheme({ theme: nativeLaunchTheme(theme) });
  } catch (error) {
    captureError(error, {
      context: "native_launch_screen_theme_sync",
      bestEffort: true,
    });
  }
}
