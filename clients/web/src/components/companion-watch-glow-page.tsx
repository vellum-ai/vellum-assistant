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

import { useEffect, useState } from "react";

import { COMPANION_CAPTURE_ACCENT } from "@/components/companion-accent";
import {
  getCompanionState,
  subscribeCompanionState,
} from "@/runtime/companion-surface";
import type { CompanionSurfaceState } from "@vellumai/ipc-contract";

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
    </div>
  );
}
