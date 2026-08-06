/**
 * Audio-reactive motion for the voice room's eyes.
 *
 * The eyes already blink, drift toward the cursor, and resize per session
 * state — but every one of those is driven by a timer, the pointer, or a
 * discrete state change. None of them is driven by sound, so through a whole
 * spoken turn the eyes hold exactly one pose. Against a band of waves that
 * *does* move, they read as artwork pasted on top.
 *
 * This hook closes that gap without touching the eye artwork, which is
 * arbitrary per-character SVG (`art.paths`) with no isolable pupil or lid to
 * animate. What it can address is the group as a whole, and two whole-group
 * gestures carry the two audio states:
 *
 * - `listening` — the eyes *open up* toward the speaker as the mic gets loud:
 *   a widening dominated by `scaleY`, plus a small lift. Reads as attention.
 * - `responding` — the eyes ride the assistant's own voice with a rounder
 *   `scale` pulse and a slight bounce, the same "energy going out" language
 *   the responding treatment uses behind them.
 *
 * Both are deliberately small (a few percent). The eyes are the room's
 * fixed point — the reference everything else moves against — so the goal is
 * for them to look *alive*, not to make them dance. Anything larger fights the
 * per-state resize tween and reads as the "spastic" pass that JARVIS-1263
 * already had to walk back.
 *
 * Written straight to a CSS custom property from a rAF loop, never React
 * state: the eyes sit inside a Motion tree, and a per-frame re-render there
 * would fight the entrance keyframes and the size tween.
 */

import { useEffect, useRef } from "react";

import { createAmplitudeSmoother } from "./voice-motion";

/** Which gesture the eyes express — `null` silences the reaction entirely. */
export type VoiceEyeReaction = "listening" | "responding" | null;

/**
 * Attack/release per gesture. Listening tracks the mic tightly so the eyes
 * answer the speaker's onset; responding is softer at both ends so the eyes
 * ride the shape of a phrase rather than every plosive in it.
 */
const BALLISTICS: Record<
  NonNullable<VoiceEyeReaction>,
  { attackMs: number; releaseMs: number }
> = {
  listening: { attackMs: 70, releaseMs: 300 },
  responding: { attackMs: 110, releaseMs: 380 },
};

/**
 * Drive `--eye-amp` (0–1) on the returned element from a live amplitude poll.
 *
 * The element also carries `data-eye-reaction`, which selects the gesture in
 * CSS (see `.voice-room-eyes-reactive` in `index.css`). Returns a ref to spread
 * onto the wrapper that should carry the motion.
 */
export function useReactiveEyes(
  reaction: VoiceEyeReaction,
  getAmplitude?: () => number,
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const getAmplitudeRef = useRef(getAmplitude);
  useEffect(() => {
    getAmplitudeRef.current = getAmplitude;
  }, [getAmplitude]);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    // No gesture, no source, or the user asked for less motion: park the var
    // at rest so the wrapper is a no-op transform rather than a stale pose.
    if (
      !reaction ||
      !getAmplitudeRef.current ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      node.style.setProperty("--eye-amp", "0");
      return;
    }

    const smoother = createAmplitudeSmoother(BALLISTICS[reaction]);
    let raf = 0;
    let lastTime = performance.now();
    let lastWritten = "";
    const tick = (now: number) => {
      const dt = Math.min(100, now - lastTime);
      lastTime = now;
      const source = getAmplitudeRef.current;
      const target = source ? Math.min(1, Math.max(0, source())) : 0;
      const next = smoother.step(target, dt).toFixed(3);
      if (next !== lastWritten) {
        lastWritten = next;
        node.style.setProperty("--eye-amp", next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Release the pose on unmount/gesture change so the next state does not
      // inherit a frozen mid-syllable value.
      node.style.setProperty("--eye-amp", "0");
    };
  }, [reaction]);

  return ref;
}
