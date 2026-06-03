// Dev flag: opt in to client-side seq gap detection. When enabled,
// the bus subscriber in `use-event-stream.ts` tracks per-conversation
// seq cursors in localStorage and triggers `reconcileActiveConversation`
// when a gap (`event.seq > stored + 1`) or a server restart
// (`event.seq < stored`) is detected.
//
// Default: disabled. Enable on production via the console to validate
// gap detection before rolling it out to all users.
//
// Surface (exposed under `window._vellumDebug.flags`):
//
//   toggleSeqGapDetection(true)   — enable + reload
//   toggleSeqGapDetection(false)  — disable + reload
//   toggleSeqGapDetection(null)   — clear + reload (same as false)
//   toggleSeqGapDetection()       — log + return current value, no reload

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";

const STORAGE_KEY = "vellum:debug:seqGapDetection";

/**
 * Read the flag synchronously. Returns `false` when no override is set,
 * the key is missing, or localStorage throws (private browsing /
 * sandboxed iframes). Safe to call during render.
 */
export function isSeqGapDetectionEnabled(): boolean {
  return getLocalSetting(STORAGE_KEY, "") === "true";
}

/**
 * Flip the flag and reload, or inspect-only when called with no args.
 *
 * Returns the value that will be in effect after the call (post-reload
 * for set/clear, current for inspect).
 */
export function setSeqGapDetectionEnabled(value?: boolean | null): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  if (value === undefined) {
    const current = isSeqGapDetectionEnabled();
    console.info(
      `[vellumDebug] seqGapDetection (current) = ${String(current)}`,
    );
    return current;
  }

  if (value === null || value === false) {
    removeLocalSetting(STORAGE_KEY);
    console.info(
      "[vellumDebug] seqGapDetection = false (cleared) — reloading…",
    );
  } else {
    setLocalSetting(STORAGE_KEY, "true");
    console.info("[vellumDebug] seqGapDetection = true — reloading…");
  }
  window.location.reload();
  return value === true;
}
