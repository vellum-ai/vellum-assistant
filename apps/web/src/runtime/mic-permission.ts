/**
 * Runtime wrapper for the OS-level (TCC) microphone access bridge.
 *
 * On macOS the OS grant governs everything: once the user denies the TCC
 * prompt, `getUserMedia` fails forever and the browser-style re-prompt
 * paths are dead ends — System Settings is the only recovery. Feature code
 * imports these functions instead of touching `window.vellum.mic` directly.
 * Off Electron (web, Capacitor iOS) and on older shells that predate the
 * channel they report "unavailable" (`null` / `false`) so callers fall
 * back to the web permission flow.
 */

import { isElectron, type MicAccessStatus } from "@/runtime/is-electron";

export type { MicAccessStatus };

/** OS-level mic grant, or null when no bridge is available. */
export async function getMicAccessStatus(): Promise<MicAccessStatus | null> {
  if (!isElectron() || !window.vellum?.mic) return null;
  try {
    return await window.vellum.mic.getStatus();
  } catch (err) {
    console.warn("getMicAccessStatus failed", err);
    return null;
  }
}

/**
 * One-shot OS microphone prompt. Resolves the resulting grant, or null
 * when no bridge is available (callers proceed to `getUserMedia`, which
 * prompts on web/Capacitor).
 */
export async function requestMicAccess(): Promise<boolean | null> {
  if (!isElectron() || !window.vellum?.mic) return null;
  try {
    return await window.vellum.mic.request();
  } catch (err) {
    console.warn("requestMicAccess failed", err);
    return null;
  }
}

/** Deep-link System Settings → Privacy & Security → Microphone. */
export async function openMicSettings(): Promise<void> {
  if (!isElectron() || !window.vellum?.mic) return;
  try {
    await window.vellum.mic.openSettings();
  } catch (err) {
    console.warn("openMicSettings failed", err);
  }
}
