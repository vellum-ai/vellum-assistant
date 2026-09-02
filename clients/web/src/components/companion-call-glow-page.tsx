/**
 * The edge of the display, lit for a call.
 *
 * Drawn in its own click-through window the size of the display, which the
 * macOS shell opens for the call and closes after it
 * (`clients/macos/src/main/companion-window.ts`). The whole screen says a
 * call is running, the way a shared screen is framed, so a live microphone is
 * never something only a pill in one corner admits to.
 *
 * **It draws the call and holds none of it.** The window is pushed the same
 * state the companion surface is, and lights when that state carries a
 * session or a dial. Nothing here is interactive: the page is decoration on a
 * desktop it does not own.
 */

import { useEffect, useState } from "react";

import { companionAccentHexFor } from "@/components/companion-accent";
import {
  getCompanionState,
  subscribeCompanionState,
} from "@/runtime/companion-surface";
import type { CompanionSurfaceState } from "@vellumai/ipc-contract";

/** The teal the creature defaults to, for a state with no colour to give. */
const DEFAULT_ACCENT = "#5eead4";

export function CompanionCallGlowPage() {
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

  // Lit from the dial, not from the session's first phase: the light is part
  // of the surface becoming the call's, and that starts on the press.
  const lit = state !== null && (state.call !== null || state.dialing === true);
  const accentHex =
    state === null
      ? DEFAULT_ACCENT
      : (companionAccentHexFor(state.call, state.character) ?? DEFAULT_ACCENT);

  return (
    <div
      className="pointer-events-none h-screen w-screen bg-transparent"
      role="presentation"
      aria-hidden
    >
      {lit && (
        <div
          className="companion-call-glow fixed inset-0"
          style={{ ["--companion-ring-accent" as string]: accentHex }}
        />
      )}
    </div>
  );
}
