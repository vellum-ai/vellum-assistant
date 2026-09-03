import { useEffect, useRef } from "react";

import type { HotkeySelection, KeyboardModifier } from "@vellumai/ipc-contract";

import {
  readFrontSelection,
  setModifierHold,
  subscribeToHotkeyEvents,
  supportsModifierHold,
} from "@/runtime/hotkey";
import {
  getSystemPermissionsState,
  requestSystemPermission,
} from "@/runtime/system-permissions";
import { createVoiceKeyGestureClassifier } from "@/domains/chat/voice/voice-key-gestures";
import type { VoiceKey } from "@/utils/voice-key";

/** What a hold began over. */
export interface HoldStart {
  /**
   * What the user had highlighted as the hold armed, when anything was.
   *
   * Asked for at the arming edge and not at the press: every chord on the
   * key passes through the held state, and a read on each of them would
   * query, and on the copy path type into, whatever application the user is
   * working in. A promise rather than a value so the microphone opens without
   * waiting on the read; what was selected cannot change while the key is
   * held, and the transcript that needs it lands well after the read does.
   * The helper answers only while the hold is still open, so a read that
   * lands after the keys are up resolves to nothing rather than to whatever
   * the user has moved on to.
   */
  selection: Promise<HotkeySelection | null>;
}

export interface VoiceKeyHandlers {
  /** Open the microphone. Called once the hold has outlasted the arming delay. */
  onHoldStart: (start: HoldStart) => void;
  /**
   * Close it and keep what was said. Called only where `onHoldStart` was, so a
   * hold that never armed never reaches this.
   */
  onHoldEnd: () => void;
  /** Start a call, or end the one that is running. */
  onDoubleTap: () => void;
  /**
   * Whether the host took the key. `false` when it refused (no helper, or
   * Input Monitoring ungranted), which is the settings card's cue to say so.
   */
  onRegistered?: (registered: boolean) => void;
}

/**
 * Whether this launch has asked for Input Monitoring on the key's behalf.
 *
 * The grant is asked for when the key is armed and not yet granted, which on a
 * fresh install is the first launch. Once per launch: a refusal is the user's
 * answer for the session, and the settings card offers the question again.
 */
let inputMonitoringAskedThisLaunch = false;

async function askForInputMonitoringOnce(): Promise<void> {
  if (inputMonitoringAskedThisLaunch) {
    return;
  }
  const state = await getSystemPermissionsState();
  if (state?.inputMonitoring.status === "granted") {
    return;
  }
  inputMonitoringAskedThisLaunch = true;
  await requestSystemPermission("inputMonitoring");
}

/**
 * The voice key, from whatever app the user is in: a hold dictates, a double
 * tap starts or ends a call.
 *
 * The edges come from the host's helper rather than the DOM, because a held
 * key only reaches a focused window and the point of this binding is that the
 * user is somewhere else entirely. The helper reports the key as a hold span,
 * and the gestures are read off the span here (see `voice-key-gestures`).
 *
 * **A hold is a microphone.** Every `onHoldStart` is closed exactly once, so
 * the effect's teardown closes an open hold too: a binding that goes away
 * mid-hold would otherwise leave the microphone on with nothing left to turn
 * it off.
 */
export function useVoiceKey({
  key,
  onHoldStart,
  onHoldEnd,
  onDoubleTap,
  onRegistered,
}: VoiceKeyHandlers & { key: VoiceKey }): void {
  // Read through a ref so a caller that re-renders does not re-register the
  // binding with the host, which would drop an open hold on the way through.
  const handlers = useRef({
    onHoldStart,
    onHoldEnd,
    onDoubleTap,
    onRegistered,
  });
  useEffect(() => {
    handlers.current = { onHoldStart, onHoldEnd, onDoubleTap, onRegistered };
  }, [onHoldStart, onHoldEnd, onDoubleTap, onRegistered]);

  // The binding as a string, so the effect re-runs on a real change of key and
  // not on every render that hands over an equal array.
  const modifiers = key.kind === "off" ? null : key.modifiers.join("+");

  useEffect(() => {
    if (modifiers === null || !supportsModifierHold()) {
      handlers.current.onRegistered?.(false);
      return;
    }

    const classifier = createVoiceKeyGestureClassifier({
      onGesture: (gesture) => {
        switch (gesture.kind) {
          case "holdStart":
            handlers.current.onHoldStart({ selection: readFrontSelection() });
            return;
          case "holdEnd":
            handlers.current.onHoldEnd();
            return;
          case "doubleTap":
            handlers.current.onDoubleTap();
            return;
        }
      },
    });

    const unsubscribe = subscribeToHotkeyEvents((event) => {
      if (event.kind !== "modifierHold") {
        return;
      }
      classifier.feed({ state: event.state, reason: event.reason });
    });

    let disposed = false;
    void setModifierHold({
      kind: "modifierOnly",
      modifiers: modifiers.split("+") as KeyboardModifier[],
    }).then(
      (result) => {
        if (!disposed) {
          handlers.current.onRegistered?.(result.ok && result.enabled);
        }
      },
      () => {
        if (!disposed) {
          handlers.current.onRegistered?.(false);
        }
      },
    );
    void askForInputMonitoringOnce();

    return () => {
      disposed = true;
      unsubscribe();
      classifier.cancel();
      void setModifierHold({ kind: "off" });
    };
  }, [modifiers]);
}
