import { useEffect } from "react";

import { advanceCompanionIntro } from "@/runtime/companion-surface";
import {
  subscribeToHotkeyEvents,
  supportsModifierHold,
} from "@/runtime/hotkey";

/**
 * Report the voice key's hold edges to the companion's introduction.
 *
 * The introduction has a beat that asks for the key to be held and moves on
 * only when a real hold reaches the app. The edge lands here, in the window
 * that owns the key (see `useVoiceKey`), and not on the surface that draws
 * the beat, so this is the side that has to speak up.
 *
 * Every `down` edge is reported, not only the ones during the run: main pushes
 * the surface's state to the surface's own windows and not to this one, so
 * this window cannot see which beat is up, or whether the run is on at all.
 * Main resolves the report against the beat it holds and drops it everywhere
 * but the beat waiting for it. The cost is one fire-and-forget message per
 * press, on a press that already has a microphone opening behind it.
 *
 * The raw edge rather than the classified gesture, deliberately: what is being
 * proven is that the key reaches the app at all, which a tap proves as well as
 * a hold does.
 */
export function useCompanionIntroHoldProof(): void {
  useEffect(() => {
    if (!supportsModifierHold()) {
      return;
    }
    return subscribeToHotkeyEvents((event) => {
      if (event.kind === "modifierHold" && event.state === "down") {
        advanceCompanionIntro("holdProven");
      }
    });
  }, []);
}
