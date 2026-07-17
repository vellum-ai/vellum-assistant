/**
 * Resolve the timezone a recurring schedule should be evaluated in.
 *
 * A cron/RRULE wall-clock recurrence needs a zone to disambiguate; when none is
 * supplied the recurrence engine falls back to the daemon host clock (UTC on a
 * managed container), firing at the wrong hour. The rest of the assistant grounds
 * time via the user's configured/detected zone (see `resolveTurnTimezoneContext`
 * in `daemon/date-context.ts`); this brings recurring schedules in line.
 */

import { getConfigReadOnly } from "../config/loader.js";
import { canonicalizeTimeZone } from "../daemon/date-context.js";
import { hasSetConstructs } from "./recurrence-engine.js";
import type { ScheduleSyntax } from "./recurrence-types.js";

/**
 * True when the expression already determines its own evaluation zone, so the
 * `timezone` field must not be resolved/overridden:
 * - an RRULE with an embedded `DTSTART;TZID=…` or a Z-anchored UTC `DTSTART`; or
 * - an RRULE set-construct (RDATE/EXDATE/multi-RRULE). `rrulestr` does not thread
 *   a caller-supplied tzid into a constructed `RRuleSet`, so a resolved zone would
 *   have no effect on firing — persisting one would be misleading.
 *
 * Cron never carries its own zone.
 */
export function expressionCarriesOwnTimezone(
  syntax: ScheduleSyntax,
  expression: string | null | undefined,
): boolean {
  if (syntax !== "rrule" || !expression) {
    return false;
  }
  if (
    /TZID=/i.test(expression) ||
    /DTSTART[^:]*:\d{8}T\d{6}Z/i.test(expression)
  ) {
    return true;
  }
  return hasSetConstructs(expression);
}

/**
 * Resolve the effective zone for a recurring schedule. An explicit caller value
 * wins (canonicalized); otherwise the user's configured zone, then the
 * client-detected zone. Returns null only when nothing is known — preserving
 * host-local evaluation for local installs where the host clock is the user's.
 *
 * Precedence mirrors `resolveTurnTimezoneContext` (configured beats detected).
 */
export function resolveScheduleTimezone(
  explicit: string | null | undefined,
): string | null {
  const explicitTz = canonicalizeTimeZone(explicit);
  if (explicitTz) {
    return explicitTz;
  }
  const ui = getConfigReadOnly().ui;
  return (
    canonicalizeTimeZone(ui.userTimezone) ??
    canonicalizeTimeZone(ui.detectedTimezone) ??
    null
  );
}
