import { useEffect, useState } from "react";

/**
 * A clock that ticks once a second while `enabled`, for the elapsed time on
 * live run rows.
 *
 * Gated rather than always-on: the bell renders in the persistent top bar on
 * every route, and a timer that ran with no live runs to show would re-render
 * it once a second forever. It also stops while the tab is hidden, since a
 * counter nobody is looking at is pure wake-ups; the first tick after the tab
 * comes back reads the real clock, so the number is right immediately rather
 * than resuming from where it was parked.
 */
export function useTickingNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let timer: ReturnType<typeof setInterval> | undefined;

    const stop = () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };

    const start = () => {
      if (timer !== undefined) {
        return;
      }
      setNow(Date.now());
      timer = setInterval(() => {
        setNow(Date.now());
      }, 1_000);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    };

    if (!document.hidden) {
      start();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled]);

  return now;
}
