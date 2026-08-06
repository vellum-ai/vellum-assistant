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
 * The functional `setDay` update returns the previous value when the date is
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
  const [day, setDay] = useState(() => toTimezoneDateString(new Date(), tz));

  const refresh = useCallback(() => {
    setDay((prev) => {
      const next = toTimezoneDateString(new Date(), tz);
      return next === prev ? prev : next;
    });
  }, [tz]);

  useBusSubscription("app.resume", refresh);

  useEffect(() => {
    // Re-read on mount and whenever `tz` changes: the initial state was
    // sampled in the zone that was live at first render.
    refresh();
    window.addEventListener("focus", refresh);
    const poll = window.setInterval(refresh, POLL_MS);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(poll);
    };
  }, [refresh]);

  return day;
}
