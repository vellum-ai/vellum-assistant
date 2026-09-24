/**
 * Screen Recording, as the app and capturing process hold it.
 *
 * Every capture this app takes on macOS runs in the mac helper: a shared call's
 * frames, the picker's previews, and computer-use screenshots. The permission
 * probe launches that executable the same way as a capture. The app can also
 * have a separate Screen Recording row, so both grants are checked.
 */

import { desktopCapturer, systemPreferences } from "electron";

import {
  queryFreshMacHelperPermission,
  type MacHelperPermissionStatus,
} from "./hotkey-helper";
import log from "./logger";
import { JsonRpcHelperError } from "./sidecar/mac-helper.client";
import { shutdownSharedCuHelper } from "./sidecar/shared-cu-helper";

/**
 * The code the helper answers a capture with when the grant is missing, as
 * `JsonRpcErrorCode.permissionDenied` in the helper names it.
 */
export const JSON_RPC_PERMISSION_DENIED = -32001;

/**
 * How long after sending the user to Settings a refused frame sends them
 * again. A share asks for frames on a cadence, and Settings jumping forward
 * on every one of them would be a window the user cannot get away from.
 */
export const ASK_COOLDOWN_MS = 30_000;

let lastStatus: MacHelperPermissionStatus | null = null;
let answering = false;
let lastAskedAtMs = Number.NEGATIVE_INFINITY;

export const readAppScreenRecordingPermission = (): MacHelperPermissionStatus =>
  systemPreferences.getMediaAccessStatus("screen");

export const requestAppScreenRecordingPermission = (): void => {
  // Electron prompts for the app's Screen Recording entry when it lists sources.
  // Do not wait for this promise: it can remain pending until Settings changes.
  void desktopCapturer
    .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
    .catch((err: unknown) => {
      log.warn("[screen recording] could not request the app grant:", err);
    });
};

/** Whether a helper call failed because Screen Recording is not granted. */
export const isScreenRecordingRefusal = (err: unknown): boolean =>
  err instanceof JsonRpcHelperError && err.code === JSON_RPC_PERMISSION_DENIED;

/**
 * The app's and capturing process's grants. The helper is read from a fresh launch.
 *
 * Fresh because a process reads its grant once: a helper that was running
 * when the user allowed it still answers no. For the same reason the
 * computer-use helper, which takes every frame, is let go when a read finds
 * the grant newly given, so the next capture starts one that can see it.
 */
export async function readScreenRecordingPermission(): Promise<MacHelperPermissionStatus> {
  const helperStatus = await queryFreshMacHelperPermission("screen");
  const appStatus = readAppScreenRecordingPermission();
  const status: MacHelperPermissionStatus =
    helperStatus === "granted" && appStatus === "granted"
      ? "granted"
      : helperStatus === "restricted" || appStatus === "restricted"
        ? "restricted"
        : helperStatus === "denied" || appStatus === "denied"
          ? "denied"
          : helperStatus === "not-determined" || appStatus === "not-determined"
            ? "not-determined"
            : "unknown";
  if (status === "granted" && lastStatus !== null && lastStatus !== "granted") {
    shutdownSharedCuHelper();
  }
  lastStatus = status;
  return status;
}

/**
 * Whether a capture may start: yes when the grant was seen last time, and
 * otherwise whatever a fresh read says. Grants are rarely taken back, so a
 * share that already passed once does not pay for a launch of the helper on
 * every start; one that was revoked since is caught by the refused frame.
 */
export async function screenRecordingGranted(): Promise<boolean> {
  if (lastStatus === "granted") {
    return true;
  }
  return (await readScreenRecordingPermission()) === "granted";
}

/**
 * What a refused frame does: find out why, and act on the answer.
 *
 * Granted after all means the helper that refused started before the grant
 * and cannot see it, so it is let go. Not granted means the user has to
 * allow it, so `askForGrant` sends them to it, at most once a cooldown.
 * Refusals arriving while one is being answered are the same refusal.
 */
export async function answerScreenRecordingRefusal(
  askForGrant: () => Promise<unknown>,
): Promise<void> {
  if (answering) {
    return;
  }
  answering = true;
  try {
    if ((await readScreenRecordingPermission()) === "granted") {
      shutdownSharedCuHelper();
      return;
    }
    const now = Date.now();
    if (now - lastAskedAtMs < ASK_COOLDOWN_MS) {
      return;
    }
    lastAskedAtMs = now;
    await askForGrant();
  } catch (err) {
    log.warn("[screen recording] could not answer a refused capture:", err);
  } finally {
    answering = false;
  }
}

export const __resetScreenRecordingPermissionForTesting = (): void => {
  lastStatus = null;
  answering = false;
  lastAskedAtMs = Number.NEGATIVE_INFINITY;
};
