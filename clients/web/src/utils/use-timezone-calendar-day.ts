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
 * The functional `setSample` update returns the previous value when the date is
 * unchanged, so the poll notifies no one on all but the single tick a day that
 * actually crosses a boundary.
 */

import { useCallback, useEffect, useState } from "react";

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
  // The date and the zone it was read in are one value, never two. A date is
  // only an answer for the zone that produced it, so storing either alone
  // leaves the other free to drift and lets the hook report a date that was
  // never today anywhere.
  const [sample, setSample] = useState(() => ({
    day: toTimezoneDateString(new Date(), tz),
    tz,
  }));

  const refresh = useCallback(() => {
    setSample((prev) => {
      const day = toTimezoneDateString(new Date(), tz);
      return prev.day === day && prev.tz === tz ? prev : { day, tz };
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

  if (sample.tz !== tz) {
    // The zone changed, which invalidates the sample outright: re-read now and
    // return the fresh date, rather than let one render address a day the new
    // zone is not on. That render's date reaches a query key, so being wrong
    // for it means fetching the wrong window, not just showing one.
    const day = toTimezoneDateString(new Date(), tz);
    setSample({ day, tz });
    return day;
  }

  return sample.day;
}
