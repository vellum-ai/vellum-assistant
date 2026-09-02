/**
 * JS side of the Android shell's `InstallReferrer` plugin, which reads the
 * Play Store install referrer.
 *
 * A user who taps a campaign link, lands in Play, and installs arrives in the
 * app with no URL params, so the referrer is the only attribution a Play
 * install carries. A native auth entry captures it into device storage on
 * demand and spends it on the flow it posts. Device scope is deliberate: the
 * value describes the physical install, not an account, so it survives logout.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

import { readAttributionParams } from "@/domains/account/social-auth";
import {
  getDeviceSetting,
  hasDeviceSetting,
  setDeviceSetting,
} from "@/utils/device-settings";

interface InstallReferrerPlugin {
  read(): Promise<{ referrer?: string }>;
}

const InstallReferrer =
  registerPlugin<InstallReferrerPlugin>("InstallReferrer");

/**
 * Allowlisted attribution from this install's Play referrer, captured into
 * device storage on the way out and returned to the caller. `{}` on every
 * other platform, on a shell whose plugin predates this bundle, and when the
 * bridge answers nothing (docs/CAPACITOR.md, "The skew rule").
 *
 * The shell bounds its own read and always answers, so this awaits it with no
 * bound of its own; a shorter bound here would abandon a referrer the shell
 * goes on to cache forever.
 */
export async function captureInstallReferrer(): Promise<
  Record<string, string>
> {
  if (Capacitor.getPlatform() !== "android") {
    return {};
  }
  if (hasDeviceSetting("installReferrer")) {
    // Re-filtered on read so a hand-edited or stale stored value can never
    // widen what reaches the wire.
    return readAttributionParams(getDeviceSetting("installReferrer", ""));
  }
  try {
    const { referrer } = await InstallReferrer.read();
    const attribution = readAttributionParams(referrer ?? "");
    const captured = new URLSearchParams(attribution).toString();
    if (captured) {
      setDeviceSetting("installReferrer", captured);
    }
    return attribution;
  } catch (error) {
    console.debug("[install-referrer] read unavailable:", error);
    return {};
  }
}

/**
 * Record that a native auth flow has spent a captured referrer. The emptied
 * key stays behind as that record: its presence, an empty value included, is
 * what stops the next signup on this device from re-reading the bridge (the
 * shell answers `read()` with the same value forever) and inheriting this
 * install's campaign.
 *
 * A flow that captured nothing has nothing to spend, so it leaves the key
 * absent and a later attempt free to retry.
 */
export function markInstallReferrerSpent(): void {
  if (getDeviceSetting("installReferrer", "") === "") {
    return;
  }
  setDeviceSetting("installReferrer", "");
}
