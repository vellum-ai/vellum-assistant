// Dev flag: opt in to the new avatar progress-badge UX. When disabled
// (default), the chat shows the long-standing transcript "thinking…"
// dots; when enabled, the dots are hidden and a small pulsing badge
// renders on the assistant avatar instead.
//
// Mechanism: `setProgressBadgeEnabled(...)` writes to localStorage and
// reloads. The flag is read synchronously by both the transcript
// builder (to suppress the old `ThinkingItem`) and `ChatAvatar` (to
// gate the new badge), so we want a uniform world post-flip and a
// reload is the cheapest way to get one.
//
// Surface (exposed under `window._vellumDebug.flags`):
//
//   toggleProgressBadge(true)   — enable + reload
//   toggleProgressBadge(false)  — disable + reload
//   toggleProgressBadge(null)   — clear + reload (same as false)
//   toggleProgressBadge()       — log + return current value, no reload

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";

const STORAGE_KEY = "vellum:debug:useProgressBadge";

/**
 * Read the flag synchronously. Returns `false` when no override is set,
 * the key is missing, or localStorage throws (private browsing /
 * sandboxed iframes). Safe to call during render.
 */
export function isProgressBadgeEnabled(): boolean {
  return getLocalSetting(STORAGE_KEY, "") === "true";
}

/**
 * Flip the flag and reload, or inspect-only when called with no args.
 *
 * Returns the value that will be in effect after the call (post-reload
 * for set/clear, current for inspect).
 */
export function setProgressBadgeEnabled(value?: boolean | null): boolean {
  if (typeof window === "undefined") return false;

  if (value === undefined) {
    const current = isProgressBadgeEnabled();
    console.info(
      `[vellumDebug] useProgressBadge (current) = ${String(current)}`,
    );
    return current;
  }

  if (value === null || value === false) {
    removeLocalSetting(STORAGE_KEY);
    console.info(
      "[vellumDebug] useProgressBadge = false (cleared) — reloading…",
    );
  } else {
    setLocalSetting(STORAGE_KEY, "true");
    console.info("[vellumDebug] useProgressBadge = true — reloading…");
  }
  window.location.reload();
  return value === true;
}
