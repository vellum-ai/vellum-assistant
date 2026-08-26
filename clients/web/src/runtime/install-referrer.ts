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
 * Bound on the bridge read. It sits on the auth critical path, so a Play
 * Store that binds but never answers must not hold the sign-in button.
 */
const READ_TIMEOUT_MS = 2_000;

/**
 * Capture the Play install referrer into device storage, filtered to the
 * allowlist. A missing plugin degrades to storing nothing, never an error
 * (docs/CAPACITOR.md, "The skew rule").
 *
 * The stored key's presence, an empty value included, is the record that this
 * install's referrer has been asked for. The shell answers `read()` with the
 * same value forever, so a spent referrer must never re-arm the bridge onto
 * the next user to sign up here. A read that answers nothing stores nothing,
 * leaving a later attempt free to retry.
 */
export async function captureInstallReferrer(): Promise<void> {
  if (Capacitor.getPlatform() !== "android") {
    return;
  }
  if (hasDeviceSetting("installReferrer")) {
    return;
  }
  try {
    const attribution = new URLSearchParams(
      readAttributionParams(await readReferrer()),
    ).toString();
    if (!attribution) {
      return;
    }
    setDeviceSetting("installReferrer", attribution);
  } catch (error) {
    console.debug("[install-referrer] read unavailable:", error);
  }
}

/** The shell's referrer, or `""` when it does not answer within the bound. */
async function readReferrer(): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { referrer } = await Promise.race([
      InstallReferrer.read(),
      new Promise<{ referrer?: string }>((resolve) => {
        timer = setTimeout(() => {
          console.debug(
            `[install-referrer] read did not answer in ${READ_TIMEOUT_MS}ms`,
          );
          resolve({});
        }, READ_TIMEOUT_MS);
      }),
    ]);
    return referrer ?? "";
  } finally {
    clearTimeout(timer);
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

/**
 * Record that a native auth flow has spent the referrer. The emptied key stays
 * behind as that record, so the next signup on this device starts
 * unattributed instead of inheriting this install's campaign.
 */
export function markInstallReferrerSpent(): void {
  setDeviceSetting("installReferrer", "");
}
