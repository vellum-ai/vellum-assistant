/**
 * The assistant's eyes peeking up from the bottom edge — shared by the
 * Introduction and "How should I talk?" steps for continuity.
 *
 * SPIKE — research-onboarding flow.
 *
 * Renders the chosen avatar's eyes (whites + pupils, in the style's own
 * shapes) at the bottom of the screen, ~25% cut off, with an idle blink and a
 * slight cursor parallax. Pass `entrance` to play the Introduction grow-in
 * (the eyes rise into place, dipping a touch below rest first); otherwise they
 * sit at rest, as if carried over from the previous step.
 *
 * Decorative: `aria-hidden`, `pointer-events-none`, reduced-motion safe.
 */

import { useEffect, useMemo, useState } from "react";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";

import { pathBBox, unionBBox } from "@/utils/eye-bbox";
import { useOnboardingStageSize } from "@/domains/onboarding/hooks/use-onboarding-stage-size";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

/** How much of the eyes sits below the bottom edge — at rest, and at the dip. */
const EYE_REST_CUTOFF = 0.25;
const EYE_DIP_CUTOFF = 0.46;
/** Eye sizing: height is at most 30% of the viewport, capped so width stays
 *  on-screen. */
const EYE_TARGET_HEIGHT = 0.3;
const EYE_MAX_WIDTH = 0.85;
/** Entrance hand-off: the eyes start from the picker's centered position. */
const PICKER_CENTER_VH = 40;
/** Slight whole-eye cursor parallax. */
const CURSOR_MAX_X = 14;
const CURSOR_MAX_Y = 8;

interface OnboardingPeekingEyesProps {
  /** Play the grow-in entrance (Introduction). Otherwise the eyes are at rest. */
  entrance?: boolean;
  /** Delay before the entrance starts (lets the body cover the screen first). */
  entranceDelay?: number;
  /**
   * Increment to make the eyes jolt upward once (a Mario-style "bump", e.g. to
   * knock the integration-step coin up).
   */
  bumpNonce?: number;
  /**
   * Play the two settle blinks when the eyes settle. Off for resting eyes that
   * are simply carried over from a previous step (they just idle-blink).
   */
  settleBlink?: boolean;
}

export function OnboardingPeekingEyes({
  entrance = false,
  entranceDelay = 0,
  bumpNonce = 0,
  settleBlink = true,
}: OnboardingPeekingEyesProps) {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const reduce = useReducedMotion();
  const { w, h } = useOnboardingStageSize();

  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (reduce) return;
    const onMove = (e: MouseEvent) => {
      setPointer({
        x: (e.clientX / window.innerWidth - 0.5) * 2,
        y: (e.clientY / window.innerHeight - 0.5) * 2,
      });
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [reduce]);

  const playEntrance = entrance && !reduce;

  // A one-shot upward jolt when `bumpNonce` increments (Mario block bump).
  const bumpControls = useAnimationControls();
  useEffect(() => {
    if (bumpNonce > 0 && !reduce) {
      void bumpControls.start({
        y: [0, -34, 8, 0],
        transition: { duration: 0.45, ease: "easeOut" },
      });
    }
  }, [bumpNonce, reduce, bumpControls]);

  // Two blinks once settled (when `settleBlink`), then a slow random idle blink.
  const [blinking, setBlinking] = useState(false);
  const [entranceDone, setEntranceDone] = useState(!entrance);
  useEffect(() => {
    if (reduce || !entranceDone) return;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout>;
    const blink = (next: () => void) => {
      if (cancelled) return;
      setBlinking(true);
      t = setTimeout(() => {
        if (cancelled) return;
        setBlinking(false);
        t = setTimeout(next, 140);
      }, 140);
    };
    const idle = () => {
      t = setTimeout(() => blink(idle), 2500 + Math.random() * 4000);
    };
    // Resting eyes (carried over) skip the settle blinks and just idle.
    if (settleBlink) blink(() => blink(idle));
    else idle();
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [reduce, entranceDone, settleBlink]);

  const chosen = characters.length > 0 ? characters[selectedIndex] : undefined;

  const eye = useMemo(() => {
    if (!components || !chosen) return null;
    const def = components.eyeStyles.find((e) => e.id === chosen.eyeStyle);
    if (!def) return null;
    return { paths: def.paths, bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))) };
  }, [components, chosen]);

  if (!eye) return null;

  // Size by the smaller viewport dimension so the eyes shrink on mobile (in
  // portrait, height alone would make them oversized), capped to the viewport
  // width so wide eye styles never get cut off sideways.
  const maxEyesW = w * EYE_MAX_WIDTH;
  const eyesH = Math.min(
    Math.min(w, h) * EYE_TARGET_HEIGHT,
    (maxEyesW * eye.bbox.h) / eye.bbox.w,
  );
  const eyesW = (eyesH * eye.bbox.w) / eye.bbox.h;
  const eyesLeft = (w - eyesW) / 2;
  const eyesRestTop = h - (1 - EYE_REST_CUTOFF) * eyesH;
  const eyesStartY = (PICKER_CENTER_VH / 100) * h - (eyesRestTop + eyesH / 2);
  const eyesDipY = (EYE_DIP_CUTOFF - EYE_REST_CUTOFF) * eyesH;
  const eyeCx = eye.bbox.x + eye.bbox.w / 2;
  const eyeCy = eye.bbox.y + eye.bbox.h / 2;

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none absolute z-[2]"
      style={{
        left: eyesLeft,
        top: eyesRestTop,
        width: eyesW,
        height: eyesH,
        transformOrigin: "center",
      }}
      initial={playEntrance ? { y: eyesStartY, scale: 0.35 } : false}
      animate={
        playEntrance
          ? { y: [eyesStartY, eyesDipY, 0], scale: [0.35, 1, 1] }
          : { y: 0, scale: 1 }
      }
      transition={
        playEntrance
          ? { duration: 1, delay: entranceDelay, times: [0, 0.7, 1], ease: "easeInOut" }
          : { duration: 0 }
      }
      onAnimationComplete={() => setEntranceDone(true)}
    >
      {/* Mario-style bump (jolts up to knock the coin). */}
      <motion.div animate={bumpControls}>
      {/* Slight parallax: the whole eyes drift smoothly toward the cursor. */}
      <div
        style={{
          transform: `translate(${pointer.x * CURSOR_MAX_X}px, ${pointer.y * CURSOR_MAX_Y}px)`,
          transition: "transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <svg
          viewBox={`${eye.bbox.x} ${eye.bbox.y} ${eye.bbox.w} ${eye.bbox.h}`}
          width={eyesW}
          height={eyesH}
          style={{ overflow: "visible", display: "block" }}
        >
          <g
            style={{
              transform: blinking ? "scaleY(0.1)" : "scaleY(1)",
              transformOrigin: `${eyeCx}px ${eyeCy}px`,
              transition: "transform 0.14s ease-in-out",
            }}
          >
            {eye.paths.map((p, i) => (
              <path key={i} d={p.svgPath} fill={p.color} />
            ))}
          </g>
        </svg>
      </div>
      </motion.div>
    </motion.div>
  );
}
