/**
 * The assistant's eyes peeking up from the bottom edge of an About
 * Assistant stage — the same visual and entrance choreography as
 * onboarding's peeking eyes, but driven by the real assistant's avatar
 * (components + traits props) instead of the onboarding picker pool, and
 * sized against the stage container rather than the viewport.
 *
 * Renders the avatar's eye art (whites + pupils, in the style's own shapes)
 * ~25% cut off at the bottom, with an idle blink and a slight cursor
 * parallax. Pass `entrance` to play the onboarding grow-in — the eyes drop
 * from the stage's center (where the overview shows the full avatar),
 * dipping a touch below rest before settling with two blinks. Decorative:
 * `aria-hidden`, `pointer-events-none`, reduced-motion safe.
 */

import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

import type { StageSize } from "@/hooks/use-element-size";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

/** How much of the eyes sits below the bottom edge — at rest, and at the dip. */
const EYE_REST_CUTOFF = 0.25;
const EYE_DIP_CUTOFF = 0.46;
/** Eye sizing: height is at most 30% of the stage, capped so width stays
 *  inside the stage. */
const EYE_TARGET_HEIGHT = 0.3;
const EYE_MAX_WIDTH = 0.85;
/** Entrance hand-off: the eyes start from the stage's centered position. */
const STAGE_CENTER_FRACTION = 0.4;
/** Slight whole-eye cursor parallax. */
const CURSOR_MAX_X = 14;
const CURSOR_MAX_Y = 8;

interface AssistantPeekingEyesProps {
  components: CharacterComponents;
  traits: CharacterTraits;
  /** The stage container's box — the eyes anchor to its bottom edge. */
  stage: StageSize;
  /** Play the grow-in entrance. Otherwise the eyes are at rest. */
  entrance?: boolean;
  /** Delay before the entrance starts. */
  entranceDelay?: number;
}

export function AssistantPeekingEyes({
  components,
  traits,
  stage,
  entrance = false,
  entranceDelay = 0,
}: AssistantPeekingEyesProps) {
  const reduce = useReducedMotion();
  const { w, h } = stage;

  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (reduce) {
      return;
    }
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

  // Two blinks once settled (after an entrance), then a slow random idle
  // blink; resting eyes skip the settle blinks and just idle.
  const [blinking, setBlinking] = useState(false);
  const [entranceDone, setEntranceDone] = useState(!entrance);
  useEffect(() => {
    if (reduce || !entranceDone) {
      return;
    }
    let cancelled = false;
    let t: ReturnType<typeof setTimeout>;
    const blink = (next: () => void) => {
      if (cancelled) {
        return;
      }
      setBlinking(true);
      t = setTimeout(() => {
        if (cancelled) {
          return;
        }
        setBlinking(false);
        t = setTimeout(next, 140);
      }, 140);
    };
    const idle = () => {
      t = setTimeout(() => blink(idle), 2500 + Math.random() * 4000);
    };
    if (entrance) {
      blink(() => blink(idle));
    } else {
      idle();
    }
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [reduce, entranceDone, entrance]);

  const eye = useMemo(() => {
    const def = components.eyeStyles.find((e) => e.id === traits.eyeStyle);
    if (!def) {
      return null;
    }
    return {
      paths: def.paths,
      bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))),
    };
  }, [components, traits.eyeStyle]);

  if (!eye || w === 0 || h === 0) {
    return null;
  }

  // Size by the smaller stage dimension so the eyes shrink on narrow
  // stages, capped to the stage width so wide eye styles never get cut off
  // sideways.
  const maxEyesW = w * EYE_MAX_WIDTH;
  const eyesH = Math.min(
    Math.min(w, h) * EYE_TARGET_HEIGHT,
    (maxEyesW * eye.bbox.h) / eye.bbox.w,
  );
  const eyesW = (eyesH * eye.bbox.w) / eye.bbox.h;
  const eyesLeft = (w - eyesW) / 2;
  const eyesRestTop = h - (1 - EYE_REST_CUTOFF) * eyesH;
  const eyesStartY = STAGE_CENTER_FRACTION * h - (eyesRestTop + eyesH / 2);
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
          ? {
              duration: 1,
              delay: entranceDelay,
              times: [0, 0.7, 1],
              ease: "easeInOut",
            }
          : { duration: 0 }
      }
      onAnimationComplete={() => setEntranceDone(true)}
    >
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
  );
}

/**
 * Fraction of the stage's smaller dimension covered by the eyes' visible
 * portion — content columns reserve this much at the bottom so foreground
 * controls always clear the eyes.
 */
export const EYES_VISIBLE_FRACTION = EYE_TARGET_HEIGHT * (1 - EYE_REST_CUTOFF);
