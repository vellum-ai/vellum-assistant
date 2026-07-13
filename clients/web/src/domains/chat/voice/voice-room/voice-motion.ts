/**
 * Shared motion-spring constants for the live-voice room surfaces.
 *
 * Kept here — inside the voice domain — so the room surface declares the spring
 * once instead of hand-copying it, without reaching into the constellation
 * domain for its `NODE_SPRING`.
 */

/**
 * Room entry spring (see `voice-room.tsx`): the avatar rises from a smaller,
 * lower offset to center with a slight overshoot. Fires once when the room
 * opens; per-state expression is the avatar's own CSS loop, not a spring.
 */
export const AVATAR_ENTER_SPRING = {
  type: "spring" as const,
  stiffness: 200,
  damping: 18,
};

/**
 * Frame-rate-independent asymmetric exponential smoother for amplitude-driven
 * visuals (a VU-meter-style ballistic: fast attack, slower release).
 *
 * The live mic amplitude in the store is close to instantaneous RMS — the
 * capture worklet posts a chunk per ~2.7 ms render quantum, so its per-chunk
 * EMA (tuned for the dictation path's much larger buffers) barely filters it —
 * and speech RMS swings hard at millisecond scale. Writing it raw into a large
 * transform (the listening waves' rise) reads as chop. This smooths at the
 * visual consumer instead of the source, so the engine's barge-in / silence
 * thresholds keep seeing the responsive signal they were tuned against.
 *
 * `step(target, dtMs)` advances toward `target` with time constants `attackMs`
 * (rising) / `releaseMs` (falling): time-based `1 - exp(-dt/τ)` blending, so
 * the feel is identical at 60 Hz, 120 Hz, or across dropped frames.
 */
export function createAmplitudeSmoother({
  attackMs,
  releaseMs,
}: {
  attackMs: number;
  releaseMs: number;
}): { step: (target: number, dtMs: number) => number } {
  let value = 0;
  return {
    step(target: number, dtMs: number): number {
      const tau = target > value ? attackMs : releaseMs;
      const k = 1 - Math.exp(-Math.max(0, dtMs) / tau);
      value += (target - value) * k;
      return value;
    },
  };
}
