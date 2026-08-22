/**
 * Bridge to the iOS shell's `AppIcon` plugin
 * (`clients/ios/App/App/AppIconPlugin.swift`), which swaps the home-screen
 * icon between the alternates the build ships.
 *
 * iOS-only: alternate app icons are an iOS bundle feature with no Android
 * equivalent, and the web app has no home-screen icon to swap.
 *
 * `getState().available` is the only source of truth for which icon names
 * exist. The iOS shell loads this bundle remotely, so an arbitrarily old shell
 * can be running arbitrarily new web (see `docs/CAPACITOR.md` § The skew rule):
 * a name the web layer computes may simply not be in the installed build, and
 * only the shell can say. Every degrade path (older shell, non-iOS platform,
 * bridge failure) resolves `supported: false` with an empty `available`, so
 * callers have one thing to check and no error branch to write.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

import { captureError } from "@/lib/sentry/capture-error";
import { isNativeIOS } from "@/runtime/platform-detection";

export interface AppIconState {
  /** Whether the device and build allow swapping the icon at all. */
  supported: boolean;
  /** Active alternate icon name, or null when the primary icon is showing. */
  current: string | null;
  /** Alternate icon names this build ships, sorted. */
  available: string[];
}

interface AppIconPlugin {
  getState(): Promise<{
    supported?: boolean;
    current?: string | null;
    available?: string[];
  }>;
  set(options: {
    name: string | null;
  }): Promise<{ ok?: boolean; error?: string }>;
}

const APP_ICON_PLUGIN = "AppIcon";
const AppIcon = registerPlugin<AppIconPlugin>(APP_ICON_PLUGIN);

function unsupported(): AppIconState {
  return { supported: false, current: null, available: [] };
}

/**
 * Gates on the bridge's own plugin registry, so an older shell degrades before
 * any call is made and the `captureError`s below only ever see real faults.
 */
function isAvailable(): boolean {
  return isNativeIOS() && Capacitor.isPluginAvailable(APP_ICON_PLUGIN);
}

/** Reads what the installed shell can do, never throwing. */
export async function getAppIconState(): Promise<AppIconState> {
  if (!isAvailable()) {
    return unsupported();
  }
  try {
    // Only the result crosses this `async` boundary, never the plugin Proxy
    // itself (see docs/CAPACITOR.md).
    const { supported, current, available } = await AppIcon.getState();
    return {
      supported: supported === true,
      current: typeof current === "string" ? current : null,
      available: available ?? [],
    };
  } catch (error) {
    captureError(error, { context: "app_icon_get_state", bestEffort: true });
    return unsupported();
  }
}

/**
 * Swaps the home-screen icon to `name`, or back to the primary icon when
 * `name` is null. Resolves true only when the shell applied the change.
 *
 * iOS shows a system alert on every successful swap, so this must only ever
 * run from an explicit user action.
 */
export async function setAppIcon(name: string | null): Promise<boolean> {
  if (!isAvailable()) {
    return false;
  }
  try {
    const { ok, error: nativeError } = await AppIcon.set({ name });
    if (ok === true) {
      return true;
    }
    captureError(new Error(nativeError ?? "setAlternateIconName failed"), {
      context: "app_icon_set",
      bestEffort: true,
    });
    return false;
  } catch (error) {
    captureError(error, { context: "app_icon_set", bestEffort: true });
    return false;
  }
}
