/**
 * Reactive hook for the current effective timezone.
 *
 * The browser emits no native event when the OS timezone changes, so there is
 * nothing to subscribe to for a live zone switch. Instead we re-read the
 * effective zone on window focus and on the cross-domain bus `app.resume`
 * signal — the moments a user is most likely to return after changing their
 * system clock or crossing a timezone — plus on `device:timezone` setting
 * changes (manual override) via the device-setting watcher.
 *
 * Visibility is intentionally not listened to directly here: the EVENT_BUS
 * convention reserves `document` visibility listeners to
 * `runtime/event-sources/dom-visibility.ts`, which publishes `app.resume`
 * (fanning in page visibility, Capacitor app-state, and network-online).
 *
 * The functional `setTz` update returns the previous reference when the
 * recomputed zone is unchanged, so React skips the re-render in the common
 * no-op case.
 */

import { useCallback, useEffect, useState } from "react";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { watchDeviceSetting } from "@/utils/device-settings";
import { getEffectiveTimezone } from "@/utils/effective-timezone";

/** Returns the live effective timezone, updating on focus/resume/override changes. */
export function useEffectiveTimezone(): string {
  const [tz, setTz] = useState(getEffectiveTimezone);

  const refresh = useCallback(() => {
    setTz((prev) => {
      const next = getEffectiveTimezone();
      return next === prev ? prev : next;
    });
  }, []);

  useBusSubscription("app.resume", refresh);

  useEffect(() => {
    window.addEventListener("focus", refresh);
    const unwatch = watchDeviceSetting("timezone", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      unwatch();
    };
  }, [refresh]);

  return tz;
}
