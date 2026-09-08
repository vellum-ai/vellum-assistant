import type { ModifierHoldUpReason } from "@vellumai/ipc-contract";

/**
 * How long the key is held before the microphone opens.
 *
 * Every chord on the key passes through the held state on its way to its own
 * key, so opening on the first edge would open a microphone for the few
 * milliseconds it takes Fn+Delete to arrive. The delay is what separates a hold
 * from a chord being typed, and it is spent before anything is recorded rather
 * than trimmed off the front of the audio. It is also the longest a press can
 * be and still count as a tap, so a tap never opens the microphone.
 */
export const HOLD_ARMING_MS = 220;

/**
 * The longest gap between one tap's release and the next tap's press for the
 * pair to read as a double tap.
 */
export const DOUBLE_TAP_GAP_MS = 300;

/** What the voice key was asked for. */
export type VoiceKeyGesture =
  | { kind: "holdStart" }
  | { kind: "holdEnd" }
  | { kind: "doubleTap" };

/** One edge of the key, as the host's hold detector reports it. */
export interface VoiceKeyEdge {
  state: "down" | "up";
  /**
   * Why an `up` happened. Absent from a host built before edges said, which
   * reads as a release: the only wrong reading that makes is a chord counted
   * toward a double tap, which such a host cannot tell apart anyway.
   */
  reason?: ModifierHoldUpReason;
}

export interface VoiceKeyGestureClassifierOptions {
  onGesture: (gesture: VoiceKeyGesture) => void;
  holdArmingMs?: number;
  doubleTapGapMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface VoiceKeyGestureClassifier {
  /** Feed one edge of the key. */
  feed: (edge: VoiceKeyEdge) => void;
  /**
   * Forget everything, closing a hold that is open. For teardown, where the
   * key's closing edge is never going to arrive.
   */
  cancel: () => void;
}

/**
 * Reads the key's edges as gestures: a hold, or a double tap.
 *
 * A hold starts once the key has been down for {@link HOLD_ARMING_MS} and ends
 * when it comes up. A press released before that is a tap, provided the key
 * came up on its own: a chord (a key pressed during the hold, or another
 * modifier joining) is a shortcut on its way through, and is neither. Two taps
 * with the second press inside {@link DOUBLE_TAP_GAP_MS} of the first release
 * are a double tap, reported on the second release so that a second press that
 * turns into a hold or a chord is read as that instead.
 *
 * A single tap is deliberately nothing. The key is the user's before it is
 * ours, and macOS runs its own answer to a tap of Fn; leaving that alone is
 * what makes taking the gestures around it reasonable.
 *
 * A pure state machine over an injected clock, so it can be tested without
 * waiting on one.
 */
export function createVoiceKeyGestureClassifier({
  onGesture,
  holdArmingMs = HOLD_ARMING_MS,
  doubleTapGapMs = DOUBLE_TAP_GAP_MS,
  now = () => Date.now(),
  setTimeout: schedule = (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: unschedule = (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}: VoiceKeyGestureClassifierOptions): VoiceKeyGestureClassifier {
  let pressed = false;
  let holding = false;
  let armingTimer: unknown = null;
  /** When the last clean tap released, while a second could still pair. */
  let lastTapUpAt: number | null = null;
  /** Whether the press in progress came inside the gap after a tap. */
  let secondOfPair = false;

  const cancelArming = () => {
    if (armingTimer !== null) {
      unschedule(armingTimer);
      armingTimer = null;
    }
  };

  const feed = (edge: VoiceKeyEdge) => {
    if (edge.state === "down") {
      if (pressed) {
        return;
      }
      pressed = true;
      const downAt = now();
      secondOfPair =
        lastTapUpAt !== null && downAt - lastTapUpAt <= doubleTapGapMs;
      lastTapUpAt = null;
      armingTimer = schedule(() => {
        armingTimer = null;
        holding = true;
        secondOfPair = false;
        onGesture({ kind: "holdStart" });
      }, holdArmingMs);
      return;
    }

    if (!pressed) {
      return;
    }
    pressed = false;
    cancelArming();
    if (holding) {
      holding = false;
      onGesture({ kind: "holdEnd" });
      return;
    }
    const cleanTap = edge.reason === undefined || edge.reason === "released";
    if (!cleanTap) {
      secondOfPair = false;
      return;
    }
    if (secondOfPair) {
      secondOfPair = false;
      onGesture({ kind: "doubleTap" });
      return;
    }
    lastTapUpAt = now();
  };

  const cancel = () => {
    cancelArming();
    pressed = false;
    secondOfPair = false;
    lastTapUpAt = null;
    if (holding) {
      holding = false;
      onGesture({ kind: "holdEnd" });
    }
  };

  return { feed, cancel };
}
