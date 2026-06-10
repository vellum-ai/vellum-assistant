import { shell, systemPreferences } from "electron";
import { z } from "zod";

import { handle } from "./ipc";

/**
 * OS-level (TCC) microphone access plumbing.
 *
 * `permissions.ts` owns the web half of mic access — auto-granting the
 * renderer's `getUserMedia` permission request for trusted origins. This
 * module owns the OS half: reading the TCC grant, firing the one-shot
 * system prompt, and deep-linking System Settings once the user has denied
 * (macOS records the denial and never re-prompts the app; Settings is the
 * only recovery path).
 */

/** Mirror of `systemPreferences.getMediaAccessStatus`'s return values. */
export type MicAccessStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

const MIC_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

export const getMicAccessStatus = (): MicAccessStatus => {
  // getMediaAccessStatus exists on macOS and Windows only. Linux has no TCC
  // equivalent — report granted and let getUserMedia surface real failures.
  if (process.platform === "linux") return "granted";
  return systemPreferences.getMediaAccessStatus("microphone");
};

export const requestMicAccess = (): Promise<boolean> => {
  // askForMediaAccess is macOS-only: prompts once while the state is
  // not-determined, otherwise resolves with the recorded grant.
  if (process.platform !== "darwin") {
    return Promise.resolve(getMicAccessStatus() !== "denied");
  }
  return systemPreferences.askForMediaAccess("microphone");
};

let installed = false;

export const installMicAccessIpc = (): void => {
  if (installed) return;
  installed = true;

  handle("vellum:mic:getStatus", z.tuple([]), () => getMicAccessStatus());
  handle("vellum:mic:request", z.tuple([]), () => requestMicAccess());
  handle("vellum:mic:openSettings", z.tuple([]), async () => {
    if (process.platform !== "darwin") return;
    await shell.openExternal(MIC_SETTINGS_URL);
  });
};
