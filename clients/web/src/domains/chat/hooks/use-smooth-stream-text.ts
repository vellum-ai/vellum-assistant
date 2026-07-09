import { useEffect, useRef, useState } from "react";

import { useReducedMotion } from "motion/react";

/**
 * Fraction-per-frame drain: each frame reveals the share of the outstanding
 * backlog that a `1 - e^(-dt/τ)` exponential approach with τ = 220ms yields.
 * Reveal speed therefore scales with how far behind the reveal is — a fast
 * stream reveals fast — and once chunks stop, the tail drains in well under
 * half a second, so smoothing never meaningfully delays content; it only
 * spreads each network burst across the frames until the next one.
 */
const DRAIN_TIME_CONSTANT_MS = 220;
/** Floor so a trickling stream still reads as typing, not as stalled. */
const MIN_CHARS_PER_SECOND = 45;
/**
 * State commits are throttled below rAF rate: every commit re-renders the
 * streaming message's markdown, and ~30fps is indistinguishable from 60fps
 * for a character reveal at these speeds.
 */
const COMMIT_INTERVAL_MS = 1000 / 30;

/**
 * Re-paces streamed assistant text into a steady typewriter reveal. Network
 * chunks land in irregular bursts, which makes streamed text pop in jittery
 * word-clumps; this hook tracks the growing target string and advances a
 * revealed-prefix length every animation frame instead.
 *
 * Pass `null` whenever smoothing shouldn't apply (message not streaming, user
 * messages, non-text trailing content) — the hook returns `null` and the
 * caller renders its own text untouched. On the transition into a non-null
 * target the current text is revealed immediately (so remounting mid-stream —
 * e.g. a reload — doesn't replay the whole message) and only subsequent
 * growth is smoothed. Honors `prefers-reduced-motion` by passing the target
 * through unmodified.
 */
export function useSmoothStreamText(target: string | null): string | null {
  const reducedMotion = useReducedMotion();
  const [revealedLength, setRevealedLength] = useState(0);
  // Fractional progress lives in refs so the rAF loop can advance every frame
  // while state commits stay throttled to COMMIT_INTERVAL_MS.
  const targetRef = useRef("");
  const revealedRef = useRef(0);
  const hasTarget = target !== null && !reducedMotion;

  targetRef.current = target ?? "";

  useEffect(() => {
    if (!hasTarget) return;

    // Entering a stream: show what already exists, smooth only new growth.
    revealedRef.current = targetRef.current.length;
    setRevealedLength(targetRef.current.length);

    let raf = 0;
    let last = performance.now();
    let lastCommit = 0;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const targetLength = targetRef.current.length;
      let revealed = Math.min(revealedRef.current, targetLength);
      if (revealed < targetLength) {
        const backlog = targetLength - revealed;
        const step = Math.max(
          backlog * (1 - Math.exp(-dt / DRAIN_TIME_CONSTANT_MS)),
          (MIN_CHARS_PER_SECOND * dt) / 1000,
        );
        revealed = Math.min(targetLength, revealed + step);
      }
      if (revealed !== revealedRef.current) {
        revealedRef.current = revealed;
        if (now - lastCommit >= COMMIT_INTERVAL_MS || revealed >= targetLength) {
          lastCommit = now;
          setRevealedLength(Math.floor(revealed));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hasTarget]);

  if (target === null) return null;
  if (reducedMotion) return target;
  return target.slice(0, Math.max(0, Math.floor(revealedLength)));
}
