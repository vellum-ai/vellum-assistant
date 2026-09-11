import { useCallback, useEffect, useRef, useState } from "react";

import { subscribeToHotkeyEvents } from "@/runtime/hotkey";
import {
  createVoiceKeyArrivalDetector,
  type VoiceKeyArrivalDetector,
} from "@/utils/voice-key-arrival";

/**
 * Where a test of the key stands: nothing asked, a press awaited, the press
 * seen, or the wait run out with no press.
 */
export type VoiceKeyArrivalPhase =
  | "idle"
  | "waiting"
  | "arrived"
  | "neverArrived";

/** How long a press that arrived is shown before the surface goes quiet. */
const ARRIVED_SHOWN_MS = 3000;

/**
 * Whether a press of the voice key reaches the app, for a surface that asks
 * the user to press it now.
 *
 * `expectPress` starts a wait; the first edge the host reports settles it as
 * `arrived`, and the wait running out settles it as `neverArrived` (see
 * `utils/voice-key-arrival`). `arrived` clears itself after a moment, since
 * it is an answer and not a state; `neverArrived` stands until the next
 * `expectPress`, since it comes with advice the user may need to read.
 *
 * Listens for the key's edges alongside whatever binding the app already runs
 * on them, so a press seen here is also the hold or tap it always was.
 */
export function useVoiceKeyArrival(): {
  phase: VoiceKeyArrivalPhase;
  expectPress: () => void;
} {
  const [phase, setPhase] = useState<VoiceKeyArrivalPhase>("idle");
  const detector = useRef<VoiceKeyArrivalDetector | null>(null);

  useEffect(() => {
    const created = createVoiceKeyArrivalDetector({ onOutcome: setPhase });
    detector.current = created;
    const unsubscribe = subscribeToHotkeyEvents((event) => {
      if (event.kind === "modifierHold") {
        created.feed({ state: event.state, reason: event.reason });
      }
    });
    return () => {
      unsubscribe();
      created.cancel();
      detector.current = null;
    };
  }, []);

  useEffect(() => {
    if (phase !== "arrived") {
      return;
    }
    const timer = setTimeout(() => {
      setPhase("idle");
    }, ARRIVED_SHOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [phase]);

  const expectPress = useCallback(() => {
    setPhase("waiting");
    detector.current?.arm();
  }, []);

  return { phase, expectPress };
}
