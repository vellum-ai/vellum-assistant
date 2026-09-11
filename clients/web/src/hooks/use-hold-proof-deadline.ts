import { useCallback, useEffect, useState } from "react";

/**
 * How long a step that asks for the voice key waits before it says the key
 * never arrived.
 *
 * Long enough to read two lines and reach for a key nobody has pressed on
 * purpose before; short enough that a key that will never arrive is not a
 * card that appears to hang.
 */
export const HOLD_PROOF_WINDOW_MS = 6000;

export interface HoldProofDeadlineOptions {
  /** Whether the step is on screen and waiting. Off resets the clock. */
  active: boolean;
  /** The wait, for a caller that needs a shorter one than the shipped window. */
  windowMs?: number;
}

/**
 * The clock behind proof by doing: a step that asks for the voice key to be
 * held and can only be walked past by a real hold edge.
 *
 * The edge itself lands elsewhere (the app's window owns the key and reports
 * the edge to main, which moves the step on), so all this holds is whether the
 * wait has run out. `unproven` is the cue to say the key never reached the
 * app and offer the likely causes; `tryAgain` starts the wait over.
 */
export function useHoldProofDeadline({
  active,
  windowMs = HOLD_PROOF_WINDOW_MS,
}: HoldProofDeadlineOptions): {
  unproven: boolean;
  tryAgain: () => void;
} {
  const [attempt, setAttempt] = useState(0);
  const [unproven, setUnproven] = useState(false);

  useEffect(() => {
    if (!active) {
      setUnproven(false);
      return;
    }
    const timer = setTimeout(() => {
      setUnproven(true);
    }, windowMs);
    return () => {
      clearTimeout(timer);
    };
  }, [active, attempt, windowMs]);

  const tryAgain = useCallback(() => {
    setUnproven(false);
    setAttempt((count) => count + 1);
  }, []);

  return { unproven, tryAgain };
}
