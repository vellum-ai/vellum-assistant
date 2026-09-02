/**
 * The edge of the display, lit while the screen is being read.
 *
 * Drawn in its own click-through window the size of the display, which the
 * macOS shell opens for a watch session and closes after it
 * (`clients/macos/src/main/companion-window.ts`). The whole screen says it is
 * being read, the way a shared screen is framed, so a capture is never
 * something only a ring on a creature in one corner admits to.
 *
 * **It draws the session and holds none of it.** The window is pushed the
 * same state the companion surface is, and lights when that state says a
 * session is reading the screen. Nothing here is interactive: the page is
 * decoration on a desktop it does not own.
 */

import { useEffect, useRef, useState } from "react";

import { COMPANION_CAPTURE_ACCENT } from "@/components/companion-accent";
import {
  getCompanionState,
  subscribeCompanionState,
} from "@/runtime/companion-surface";
import type { CompanionSurfaceState } from "@vellumai/ipc-contract";

/**
 * How many captures this window has watched arrive, which is not the same as
 * how many the session has taken.
 *
 * `captureCount` on the pushed state is a running total that outlives any one
 * window reading it. This window is opened with the session and main replays
 * its retained state into it, so it routinely meets a session already forty
 * reads in. A flash drawn off the value would present the last of those as a
 * capture happening now, which is the one thing this indicator must never do:
 * it is worth something only because a flash means the screen was read at
 * that moment.
 *
 * So a step counts only when it lands inside a session this window was already
 * watching. That covers both ways a total arrives without a capture behind it:
 * the first render, whatever the count is by then, and the jump from nothing
 * to a session already in progress. What is left is a count moving under a
 * session that was running a moment ago, which is a read that just happened.
 *
 * The result is a key rather than a flag, so each step remounts the element
 * and replays a one-shot animation. Zero is nothing observed yet, and it
 * returns to zero when the session ends.
 */
function useObservedCaptures(captureCount: number, watching: boolean): number {
  const seen = useRef({ captureCount, watching });
  const [observed, setObserved] = useState(0);
  useEffect(() => {
    const previous = seen.current;
    seen.current = { captureCount, watching };
    if (!watching) {
      setObserved(0);
      return;
    }
    if (previous.watching && captureCount > previous.captureCount) {
      setObserved((count) => count + 1);
    }
  }, [captureCount, watching]);
  return observed;
}

export function CompanionWatchGlowPage() {
  const [state, setState] = useState<CompanionSurfaceState | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeCompanionState(setState);
    // The route chunk loads lazily after the window is created, so a state
    // pushed before this subscription registered was dropped. Catch up.
    void getCompanionState().then((initial) => {
      if (initial) {
        setState(initial);
      }
    });
    return unsubscribe;
  }, []);

  // Read as the surface reads it: only a positive answer is a session, since
  // the alternative is framing a screen nobody is reading.
  const lit = state?.watching === true;
  const observedCaptures = useObservedCaptures(state?.captureCount ?? 0, lit);

  return (
    <div
      className="pointer-events-none h-screen w-screen bg-transparent"
      role="presentation"
      aria-hidden
    >
      {lit && (
        <div
          className="companion-watch-glow fixed inset-0"
          style={{
            ["--companion-ring-accent" as string]: COMPANION_CAPTURE_ACCENT,
          }}
        />
      )}
      {/* One capture, as a single breath of light on the same frame. The frame
          says the screen is being read, which is a state; this says it was
          read just now, which is an event, and the two need different
          treatments or the second is invisible inside the first. Keyed by the
          captures this window has watched arrive, so each one remounts the
          element and replays a one-shot animation. */}
      {lit && observedCaptures > 0 && (
        <div
          key={observedCaptures}
          className="companion-watch-glow-flash fixed inset-0"
          style={{
            ["--companion-ring-accent" as string]: COMPANION_CAPTURE_ACCENT,
          }}
        />
      )}
    </div>
  );
}
