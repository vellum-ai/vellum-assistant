/**
 * Reactive hook for the current effective timezone.
 *
 * The browser emits no native event when the OS timezone changes, so there is
 * nothing to subscribe to for a live zone switch. Instead we re-read the
 * effective zone on window focus and on `visibilitychange` to visible — the
 * moments a user is most likely to return after changing their system clock or
 * crossing a timezone — plus on `device:timezone` setting changes (manual
 * override) via the device-setting watcher.
 *
 * The functional `setTz` update returns the previous reference when the
 * recomputed zone is unchanged, so React skips the re-render in the common
 * no-op case.
 */

import { useCallback, useEffect, useState } from "react";

import { watchDeviceSetting } from "@/utils/device-settings";
import { getEffectiveTimezone } from "@/utils/effective-timezone";

/** Returns the live effective timezone, updating on focus/visibility/override changes. */
export function useEffectiveTimezone(): string {
  const [tz, setTz] = useState(getEffectiveTimezone);

  const refresh = useCallback(() => {
    setTz((prev) => {
      const next = getEffectiveTimezone();
      return next === prev ? prev : next;
    });
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("visibilitychange", onVisibilityChange);
    const unwatch = watchDeviceSetting("timezone", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("visibilitychange", onVisibilityChange);
      unwatch();
    };
  }, [refresh]);

  return tz;
}
