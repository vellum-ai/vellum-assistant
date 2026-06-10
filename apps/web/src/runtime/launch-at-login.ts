import { isElectron } from "@/runtime/is-electron";

/**
 * Runtime wrapper for the Electron launch-at-login bridge
 * (`window.vellum.launchAtLogin`). Desktop-only; degrades to safe no-ops
 * on web/iOS and against older preloads that predate the channel.
 */

/** Read the current launch-at-login preference (defaults to `false` off Electron). */
export async function getLaunchAtLogin(): Promise<boolean> {
  if (!isElectron()) return false;
  const bridge = window.vellum;
  if (!bridge?.launchAtLogin) return false;
  return bridge.launchAtLogin.get();
}

/** Persist the launch-at-login preference (no-op off Electron). */
export async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  if (!isElectron()) return;
  const bridge = window.vellum;
  if (!bridge?.launchAtLogin) return;
  await bridge.launchAtLogin.set(enabled);
}
