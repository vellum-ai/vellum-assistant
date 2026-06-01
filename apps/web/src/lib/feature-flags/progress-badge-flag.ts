// Dev flag: opt in to the new avatar progress-badge UX. When disabled
// (default), the chat shows the long-standing transcript "thinking…"
// dots; when enabled, the dots are hidden and a small badge renders on
// the assistant avatar instead. The badge has two visual variants:
//   - "dots"     — a pulsing three-dot pill (the original UX).
//   - "gradient" — a glistening gradient pill that sweeps left to right,
//                  matching the "working" shimmer used elsewhere.
//
// Mechanism: `setProgressBadgeEnabled(...)` writes to localStorage and
// reloads. The flag is read synchronously by both the transcript
// builder (to suppress the old `ThinkingItem`) and `ChatAvatar` (to
// gate the new badge and pick its variant), so we want a uniform world
// post-flip and a reload is the cheapest way to get one.
//
// Surface (exposed under `window._vellumDebug.flags`):
//
//   toggleProgressBadge(true)         — enable dots variant + reload
//   toggleProgressBadge("gradient")   — enable gradient variant + reload
//   toggleProgressBadge(false)        — disable + reload
//   toggleProgressBadge(null)         — clear + reload (same as false)
//   toggleProgressBadge()             — log + return current value, no reload

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";

const STORAGE_KEY = "vellum:debug:useProgressBadge";

/** Visual variant of the avatar progress badge. */
export type ProgressBadgeVariant = "dots" | "gradient";

// Stored values: legacy `"true"` maps to the original dots variant;
// `"gradient"` selects the gradient sweep. Anything else (missing key,
// `"false"`) means the badge is off.
const GRADIENT_VALUE = "gradient";
const DOTS_VALUE = "true";

/**
 * Read the active badge variant synchronously, or `null` when the badge
 * is off (no override set, key missing, or localStorage throws — private
 * browsing / sandboxed iframes). Safe to call during render.
 */
export function getProgressBadgeVariant(): ProgressBadgeVariant | null {
  const value = getLocalSetting(STORAGE_KEY, "");
  if (value === GRADIENT_VALUE) return "gradient";
  if (value === DOTS_VALUE) return "dots";
  return null;
}

/**
 * Whether the badge is enabled in either variant. Returns `false` when
 * no override is set, the key is missing, or localStorage throws.
 * Safe to call during render.
 */
export function isProgressBadgeEnabled(): boolean {
  return getProgressBadgeVariant() !== null;
}

/**
 * Flip the flag and reload, or inspect-only when called with no args.
 *
 * `true` enables the dots variant, `"gradient"` enables the gradient
 * variant, and `false`/`null` clears the override.
 *
 * Returns the variant in effect after the call (post-reload for
 * set/clear, current for inspect).
 */
export function setProgressBadgeEnabled(
  value?: boolean | ProgressBadgeVariant | null,
): ProgressBadgeVariant | null {
  if (typeof window === "undefined") return null;

  if (value === undefined) {
    const current = getProgressBadgeVariant();
    console.info(
      `[vellumDebug] useProgressBadge (current) = ${current ?? "false"}`,
    );
    return current;
  }

  if (value === null || value === false) {
    removeLocalSetting(STORAGE_KEY);
    console.info(
      "[vellumDebug] useProgressBadge = false (cleared) — reloading…",
    );
    window.location.reload();
    return null;
  }

  const variant: ProgressBadgeVariant = value === "gradient" ? "gradient" : "dots";
  setLocalSetting(STORAGE_KEY, variant === "gradient" ? GRADIENT_VALUE : DOTS_VALUE);
  console.info(`[vellumDebug] useProgressBadge = ${variant} — reloading…`);
  window.location.reload();
  return variant;
}
