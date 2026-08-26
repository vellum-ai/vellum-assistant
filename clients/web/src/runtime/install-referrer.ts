/**
 * JS side of the Android shell's `InstallReferrer` plugin, which reads the
 * Play Store install referrer.
 *
 * A user who taps a campaign link, lands in Play, and installs arrives in the
 * app with no URL params, so the referrer is the only attribution a Play
 * install carries. It is captured into device storage at startup and read back
 * when a signup posts attribution. Device scope is deliberate: the value
 * describes the physical install, not an account, so it survives logout.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

import { readAttributionParams } from "@/domains/account/social-auth";
import {
  getDeviceSetting,
  removeDeviceSetting,
  setDeviceSetting,
} from "@/utils/device-settings";

type InstallReferrerResult = {
  referrer?: string;
  referrerClickTimestampSeconds?: number;
  installBeginTimestampSeconds?: number;
};

interface InstallReferrerPlugin {
  read(): Promise<InstallReferrerResult>;
}

const InstallReferrer =
  registerPlugin<InstallReferrerPlugin>("InstallReferrer");

/**
 * Read the Play install referrer once and persist its allowlisted params.
 * Safe to call on every startup: a stored value short-circuits the bridge.
 *
 * A missing plugin is an expected state, not an error. The shell ships on
 * Play's review cadence while this bundle goes live on every user's next
 * launch, so an older shell without the plugin is normal after any deploy
 * (docs/CAPACITOR.md, "The skew rule"). Nothing here reports to Sentry.
 */
export async function captureInstallReferrer(): Promise<void> {
  if (Capacitor.getPlatform() !== "android") {
    return;
  }
  if (getDeviceSetting("installReferrer", "")) {
    return;
  }
  try {
    const { referrer } = await InstallReferrer.read();
    const attribution = new URLSearchParams(
      readAttributionParams(referrer ?? ""),
    ).toString();
    if (!attribution) {
      return;
    }
    setDeviceSetting("installReferrer", attribution);
  } catch (error) {
    console.debug("[install-referrer] read unavailable:", error);
  }
}

/**
 * Allowlisted attribution captured from the install referrer, or `{}` when
 * this device has none. Re-filtered on read so a hand-edited or stale stored
 * value can never widen what reaches the wire.
 */
export function readStoredInstallReferrer(): Record<string, string> {
  return readAttributionParams(getDeviceSetting("installReferrer", ""));
}

/** Drop the captured referrer once it has been spent on a signup. */
export function clearStoredInstallReferrer(): void {
  removeDeviceSetting("installReferrer");
}
