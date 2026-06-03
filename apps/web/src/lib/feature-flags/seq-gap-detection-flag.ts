// Client-side seq gap detection. When enabled, the bus subscriber in
// `use-event-stream.ts` tracks per-conversation seq cursors in
// localStorage and triggers `reconcileActiveConversation` when a gap
// (`event.seq > stored + 1`) or a server restart (`event.seq < stored`)
// is detected.
//
// Default: disabled. Enable via the console to opt a specific
// environment into gap detection.
//
// Surface (exposed under `window._vellumDebug.flags`):
//
//   toggleSeqGapDetection(true)   — enable + reload
//   toggleSeqGapDetection(false)  — disable + reload
//   toggleSeqGapDetection(null)   — clear + reload (reverts to default: disabled)
//   toggleSeqGapDetection()       — log + return current value, no reload

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";

const STORAGE_KEY = "vellum:debug:seqGapDetection";

/**
 * Read the flag synchronously. Returns `false` when no override is set
 * (disabled by default) or when localStorage throws (private browsing /
 * sandboxed iframes). Returns `true` only when explicitly enabled via
 * `setSeqGapDetectionEnabled(true)`. Safe to call during render.
 */
export function isSeqGapDetectionEnabled(): boolean {
  const stored = getLocalSetting(STORAGE_KEY, "");
  if (stored === "true") {
    return true;
  }
  return false;
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

  if (value === null) {
    removeLocalSetting(STORAGE_KEY);
    console.info(
      "[vellumDebug] seqGapDetection = default (cleared) — reloading…",
    );
  } else if (value === false) {
    setLocalSetting(STORAGE_KEY, "false");
    console.info("[vellumDebug] seqGapDetection = false — reloading…");
  } else {
    setLocalSetting(STORAGE_KEY, "true");
    console.info("[vellumDebug] seqGapDetection = true — reloading…");
  }
  window.location.reload();
  return value === true;
}
