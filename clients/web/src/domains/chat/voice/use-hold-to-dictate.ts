import { useEffect, useRef } from "react";

import type { HotkeySelection, KeyboardModifier } from "@vellumai/ipc-contract";

import {
  readFrontSelection,
  setModifierHold,
  subscribeToHotkeyEvents,
  supportsModifierHold,
} from "@/runtime/hotkey";

/**
 * The binding the hold ships on.
 *
 * Two modifiers held together, which is a shape no `globalShortcut` can express
 * and so a shape nothing is registered against system-wide: holding them with
 * no key sends nothing to the app in front, and nothing is taken away from it
 * for as long as Vellum runs. That is the whole reason this is a hold rather
 * than a chord (see the note on `toggleVoice` in `commands.ts`, which ships
 * unbound because a chord cannot be picked safely).
 *
 * Ctrl+Option is VoiceOver's own modifier. Anyone running VoiceOver has every
 * one of its commands on this pair, which is the reason the binding is worth
 * rebinding and the reason it is stated in one place.
 */
export const HOLD_TO_DICTATE_MODIFIERS: KeyboardModifier[] = [
  "control",
  "option",
];

/**
 * How long the set is held before the microphone opens.
 *
 * Every chord on these modifiers passes through the held state on its way to
 * its own key, so opening on the first edge would open a microphone for the few
 * milliseconds it takes Ctrl+Option+F to arrive. The delay is what separates a
 * hold from a chord being typed, and it is spent before anything is recorded
 * rather than trimmed off the front of the audio.
 *
 * Held here rather than in the detector, which stays a pure state machine with
 * no clock in it.
 */
export const HOLD_ARMING_MS = 220;

/** What a hold began over. */
export interface HoldStart {
  /**
   * What the user had highlighted as the hold armed, when anything was.
   *
   * Asked for at the arming edge and not at the press: every chord on the
   * set passes through the held state, and a read on each of them would
   * query, and on the copy path type into, whatever application the user is
   * working in. A promise rather than a value so the microphone opens without
   * waiting on the read; what was selected cannot change while the keys are
   * held, and the transcript that needs it lands well after the read does.
   * The helper answers only while the hold is still open, so a read that
   * lands after the keys are up resolves to nothing rather than to whatever
   * the user has moved on to.
   */
  selection: Promise<HotkeySelection | null>;
}

export interface HoldToDictateHandlers {
  /** Open the microphone. Called once the hold has outlasted the arming delay. */
  onHoldStart: (start: HoldStart) => void;
  /**
   * Close it and keep what was said. Called only where `onHoldStart` was, so a
   * hold that never armed never reaches this.
   */
  onHoldEnd: () => void;
}

/**
 * Dictation across a held modifier set, from whatever app the user is in.
 *
 * The edges come from the host's helper rather than the DOM, because a held
 * chord only reaches a focused window and the point of this binding is that the
 * user is somewhere else entirely.
 *
 * **The pair is a span, and the span is a microphone.** Every `down` that opens
 * one is closed exactly once, so the effect's teardown closes an open hold too:
 * a binding that goes away mid-hold would otherwise leave the microphone on
 * with nothing left to turn it off.
 */
export function useHoldToDictate({
  enabled = true,
  onHoldStart,
  onHoldEnd,
}: HoldToDictateHandlers & { enabled?: boolean }): void {
  // Read through a ref so a caller that re-renders does not re-register the
  // binding with the host, which would drop an open hold on the way through.
  const handlers = useRef({ onHoldStart, onHoldEnd });
  useEffect(() => {
    handlers.current = { onHoldStart, onHoldEnd };
  }, [onHoldStart, onHoldEnd]);

  useEffect(() => {
    if (!enabled || !supportsModifierHold()) {
      return;
    }

    let armingTimer: ReturnType<typeof setTimeout> | null = null;
    let open = false;

    const cancelArming = () => {
      if (armingTimer !== null) {
        clearTimeout(armingTimer);
        armingTimer = null;
      }
    };

    const endIfOpen = () => {
      cancelArming();
      if (!open) {
        return;
      }
      open = false;
      handlers.current.onHoldEnd();
    };

    const unsubscribe = subscribeToHotkeyEvents((event) => {
      if (event.kind !== "modifierHold") {
        return;
      }
      if (event.state === "down") {
        cancelArming();
        armingTimer = setTimeout(() => {
          armingTimer = null;
          open = true;
          handlers.current.onHoldStart({ selection: readFrontSelection() });
        }, HOLD_ARMING_MS);
        return;
      }
      endIfOpen();
    });

    void setModifierHold({
      kind: "modifierOnly",
      modifiers: HOLD_TO_DICTATE_MODIFIERS,
    });

    return () => {
      unsubscribe();
      endIfOpen();
      void setModifierHold({ kind: "off" });
    };
  }, [enabled]);
}
