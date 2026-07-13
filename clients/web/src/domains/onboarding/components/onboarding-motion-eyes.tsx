/**
 * The assistant's eyes, peeking from the bottom edge, fully driven by the
 * caller's motion values so a step can make them rise, grow, dash, blink, etc.
 *
 * SPIKE — research-onboarding flow.
 *
 * Geometry (size + resting center) mirrors `OnboardingPeekingEyes`, so a step
 * that wants to choreograph the eyes can hide the backdrop's resting pair (via
 * `showBottomEyes={false}`) and swap in these without a visible jump.
 */

import { useMemo } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";

import { pathBBox, unionBBox, type BBox } from "@/components/avatar/eye-bbox";
import { useOnboardingStageSize } from "@/domains/onboarding/hooks/use-onboarding-stage-size";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

const EYE_TARGET_HEIGHT = 0.3;
const EYE_MAX_WIDTH = 0.85;
const EYE_REST_CUTOFF = 0.25;

export interface OnboardingEyeArt {
  paths: { svgPath: string; color: string }[];
  bbox: BBox;
}

export interface OnboardingEyes {
  /** The chosen avatar's eye art, or null until components/character load. */
  art: OnboardingEyeArt | null;
  eyesW: number;
  eyesH: number;
  /** Resting vertical center: peeking from the bottom, ~25% cut off. */
  restCy: number;
  /** Horizontal center of the viewport. */
  centerX: number;
  w: number;
  h: number;
}

/** Resolve the chosen avatar's eyes + the backdrop-matching geometry. */
export function useOnboardingEyes(): OnboardingEyes {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const chosen = characters.length > 0 ? characters[selectedIndex] : undefined;
  const { w, h } = useOnboardingStageSize();

  const art = useMemo<OnboardingEyeArt | null>(() => {
    if (!components || !chosen) return null;
    const def = components.eyeStyles.find((e) => e.id === chosen.eyeStyle);
    if (!def) return null;
    return {
      paths: def.paths,
      bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))),
    };
  }, [components, chosen]);

  const eyesH = art
    ? Math.min(
        Math.min(w, h) * EYE_TARGET_HEIGHT,
        (w * EYE_MAX_WIDTH * art.bbox.h) / art.bbox.w,
      )
    : 0;
  const eyesW = art ? (eyesH * art.bbox.w) / art.bbox.h : 0;
  const restCy = h - EYE_REST_CUTOFF * eyesH;

  return { art, eyesW, eyesH, restCy, centerX: w / 2, w, h };
}

/**
 * Render the eyes at a caller-driven center (`eyeCy` vertical, `centerX` + the
 * optional `eyeX` offset horizontal) and `eyeScale`, with a `blinking` squish.
 * Scaling is about the box center, so growing/shrinking keeps the eyes pinned.
 */
export function MotionEyes({
  art,
  eyesW,
  eyesH,
  centerX,
  eyeCy,
  eyeScale,
  eyeX,
  blinking,
  className = "pointer-events-none absolute top-0 z-0",
}: {
  art: OnboardingEyeArt;
  eyesW: number;
  eyesH: number;
  centerX: number;
  eyeCy: MotionValue<number>;
  eyeScale: MotionValue<number>;
  /** Horizontal offset from center (px). Omit to stay centered. */
  eyeX?: MotionValue<number>;
  blinking: boolean;
  className?: string;
}) {
  const top = useTransform(eyeCy, (v) => v - eyesH / 2);
  const cx = art.bbox.x + art.bbox.w / 2;
  const cy = art.bbox.y + art.bbox.h / 2;
  return (
    <motion.div
      aria-hidden="true"
      className={className}
      style={{
        left: centerX - eyesW / 2,
        top: 0,
        x: eyeX,
        y: top,
        width: eyesW,
        height: eyesH,
        scale: eyeScale,
        transformOrigin: "center",
      }}
    >
      <svg
        viewBox={`${art.bbox.x} ${art.bbox.y} ${art.bbox.w} ${art.bbox.h}`}
        width={eyesW}
        height={eyesH}
        style={{ overflow: "visible", display: "block" }}
      >
        <g
          style={{
            transform: blinking ? "scaleY(0.1)" : "scaleY(1)",
            transformOrigin: `${cx}px ${cy}px`,
            transition: "transform 0.13s ease-in-out",
          }}
        >
          {art.paths.map((p, i) => (
            <path key={i} d={p.svgPath} fill={p.color} />
          ))}
        </g>
      </svg>
    </motion.div>
  );
}
