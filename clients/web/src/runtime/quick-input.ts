/**
 * Runtime wrapper for the quick input bridge surface.
 *
 * Feature code imports these functions instead of touching
 * `window.vellum.quickInput` directly. Off-Electron the functions
 * are no-ops so the quick input page degrades gracefully if someone
 * navigates to `/assistant/quick-input` in a regular browser.
 */

import { isElectron } from "@/runtime/is-electron";

export async function submitQuickInput(message: string): Promise<void> {
  if (!isElectron()) {
    return;
  }
  await window.vellum?.quickInput?.submit(message);
}

export async function dismissQuickInput(): Promise<void> {
  if (!isElectron()) {
    return;
  }
  await window.vellum?.quickInput?.dismiss();
}
