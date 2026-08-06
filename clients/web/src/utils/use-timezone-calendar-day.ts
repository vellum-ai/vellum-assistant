/**
 * Reactive hook for today's calendar date in a given IANA timezone.
 *
 * A relative window ("last 30 days") is anchored on the current calendar day,
 * so bounds derived from one go stale the moment that day rolls over. The
 * browser emits no event for a rollover, and {@link useEffectiveTimezone} does
 * not cover it: the zone string is identical either side of local midnight, so
 * nothing downstream re-renders.
 *
 * The date is therefore re-read on the signals that mean "the user is back"
 * (window focus and the cross-domain bus `app.resume`), plus a coarse poll for
 * the surface that is simply left open across midnight with no interaction.
 *
 * The functional `setSampledAt` update returns the previous value when the date
 * is unchanged, so the poll notifies no one on all but the single tick a day
 * that actually crosses a boundary.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { toTimezoneDateString } from "@/components/charts/format-date-label";
import { useBusSubscription } from "@/hooks/use-bus-subscription";

/**
 * Coarse enough to be free (one `Intl` format, and a no-op state update on
 * every tick but one), fine enough that a surface left open overnight corrects
 * itself within a minute of midnight rather than at the next interaction.
 */
const POLL_MS = 60_000;

/** Returns `YYYY-MM-DD` for "now" in `tz`, updating when that date changes. */
export function useTimezoneCalendarDay(tz: string): string {
  // State holds the instant the day was last sampled, not the date itself. The
  // date is a function of that instant and `tz`, so a zone change resolves
  // during the same render rather than a commit later: state that stored the
  // formatted date would hand out the previous zone's answer for one render,
  // and anything keyed on it (a query, a fetch) would act on it.
  const [sampledAt, setSampledAt] = useState(() => Date.now());

  const refresh = useCallback(() => {
    setSampledAt((prev) => {
      const now = Date.now();
      return toTimezoneDateString(new Date(now), tz) ===
        toTimezoneDateString(new Date(prev), tz)
        ? prev
        : now;
    });
  }, [tz]);

  useBusSubscription("app.resume", refresh);

  useEffect(() => {
    window.addEventListener("focus", refresh);
    const poll = window.setInterval(refresh, POLL_MS);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(poll);
    };
  }, [refresh]);

  return useMemo(
    () => toTimezoneDateString(new Date(sampledAt), tz),
    [sampledAt, tz],
  );
}
