import type { ModifierHoldUpReason } from "@vellumai/ipc-contract";

/**
 * How long an expected press is waited for before it is reported as never
 * having arrived. Long enough to find the key and hold it, short enough that
 * a user who did is not left wondering whether anything is listening.
 */
export const VOICE_KEY_ARRIVAL_TIMEOUT_MS = 4000;

/** What became of a press that was expected. */
export type VoiceKeyArrival = "arrived" | "neverArrived";

/** One edge of the key, as the host's hold detector reports it. */
export interface VoiceKeyArrivalEdge {
  state: "down" | "up";
  reason?: ModifierHoldUpReason;
}

export interface VoiceKeyArrivalDetectorOptions {
  onOutcome: (outcome: VoiceKeyArrival) => void;
  timeoutMs?: number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface VoiceKeyArrivalDetector {
  /** Expect a press. Arming while one is expected starts the wait over. */
  arm: () => void;
  /**
   * Feed one edge of the key. While a press is expected, the first edge the
   * user made is it. Nothing while none is expected.
   */
  feed: (edge: VoiceKeyArrivalEdge) => void;
  /** Stop expecting a press, reporting nothing. */
  cancel: () => void;
}

/**
 * Tells whether a press the user was asked for ever reached the app.
 *
 * The key is watched by a helper outside this process, and anything between
 * the keyboard and that helper (another app's event tap, a system remap of
 * the modifier keys, a keyboard tool) can take the press without a word. The
 * app hears nothing either way, so the only signal is the absence of one:
 * armed when a press is expected, an edge within the wait is `arrived`, and
 * the wait running out is `neverArrived`.
 *
 * An `up` the host says it made itself (`cancelled`: the binding cleared, the
 * helper going away) is not the user's press, and counts for nothing.
 *
 * A pure state machine over an injected clock, so it can be tested without
 * waiting on one.
 */
export function createVoiceKeyArrivalDetector({
  onOutcome,
  timeoutMs = VOICE_KEY_ARRIVAL_TIMEOUT_MS,
  setTimeout: schedule = (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: unschedule = (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}: VoiceKeyArrivalDetectorOptions): VoiceKeyArrivalDetector {
  let timer: unknown = null;

  const disarm = () => {
    if (timer !== null) {
      unschedule(timer);
      timer = null;
    }
  };

  const arm = () => {
    disarm();
    timer = schedule(() => {
      timer = null;
      onOutcome("neverArrived");
    }, timeoutMs);
  };

  const feed = (edge: VoiceKeyArrivalEdge) => {
    if (timer === null || edge.reason === "cancelled") {
      return;
    }
    disarm();
    onOutcome("arrived");
  };

  return { arm, feed, cancel: disarm };
}
