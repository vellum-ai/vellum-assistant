/**
 * Single source of truth for "what timezone should the client use right now?".
 *
 * Two modes, keyed off the `device:timezone` setting:
 *
 * - **Manual override** (`device:timezone` is a non-empty IANA zone): the user
 *   deliberately picked a zone. It always wins and is intentionally NOT
 *   auto-updated when the OS timezone changes — a manual choice stays put.
 * - **Auto** (`device:timezone` is empty/absent): follow the live browser zone.
 *   `getBrowserTimezone()` re-reads `Intl` on every call, so switching OS
 *   timezones is reflected the next time this resolver runs.
 *
 * Callers should use this instead of `getBrowserTimezone()` directly so the
 * override-vs-auto semantics are applied consistently across the web client.
 */

import { getBrowserTimezone } from "@/utils/browser-timezone";
import { getDeviceSetting } from "@/utils/device-settings";

/**
 * Resolve the effective timezone: a trimmed `device:timezone` override when
 * present, otherwise the live browser zone.
 */
export function getEffectiveTimezone(): string {
  const override = getDeviceSetting("timezone", "").trim();
  if (override) return override;
  return getBrowserTimezone();
}
