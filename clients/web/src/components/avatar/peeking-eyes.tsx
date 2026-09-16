/**
 * An avatar's eyes peeking up from the bottom edge of a stage.
 *
 * Renders the eye art (whites + pupils, in the style's own shapes) sized
 * against the stage box and cut off by its bottom edge, with an idle blink and
 * a slight cursor parallax. Pass `entrance` to play the grow-in: the eyes drop
 * from the stage's center (where a full avatar sits), dipping a touch below
 * rest before settling with two blinks.
 *
 * Presentational and decorative: `aria-hidden`, `pointer-events-none`,
 * reduced-motion safe. It takes the art and the stage box as props and knows
 * nothing about where either came from, so onboarding's backdrop (picker pool
 * plus onboarding stage) and the About Assistant stage (the real assistant's
 * avatar plus its own container) get one set of geometry, timings and motion
 * rather than a copy each.
 */

import { useEffect, useState } from "react";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";

import type { StageSize } from "@/hooks/use-element-size";
import type { BBox } from "@/utils/eye-bbox";

/** How much of the eyes sits below the bottom edge: at rest, and at the dip. */
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

/** An eye style's paths plus the union bounding box that frames them. */
export interface PeekingEyeArt {
  paths: { svgPath: string; color: string }[];
  bbox: BBox;
}

export interface PeekingEyesProps {
  art: PeekingEyeArt;
  /** The stage container's box. The eyes anchor to its bottom edge. */
  stage: StageSize;
  /**
   * Play the grow-in entrance, and the two settle blinks that close it out.
   * Otherwise the eyes are at rest and simply idle-blink, as if carried over
   * from a previous step.
   */
  entrance?: boolean;
  /** Delay before the entrance starts. */
  entranceDelay?: number;
  /**
   * Extra sink below the resting position, as a fraction of stage height, for
   * stages whose bottom edge is not where the eyes should read as cut off.
   */
  restSinkFraction?: number;
  /**
   * Increment to make the eyes jolt upward once (a Mario-style "bump", e.g. to
   * knock the integration-step coin up). Omit to leave out the bump layer.
   */
  bumpNonce?: number;
}

export function PeekingEyes({
  art,
  stage,
  entrance = false,
  entranceDelay = 0,
  restSinkFraction = 0,
  bumpNonce,
}: PeekingEyesProps) {
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

  // A one-shot upward jolt when `bumpNonce` increments (Mario block bump).
  const bumpControls = useAnimationControls();
  useEffect(() => {
    if ((bumpNonce ?? 0) > 0 && !reduce) {
      void bumpControls.start({
        y: [0, -34, 8, 0],
        transition: { duration: 0.45, ease: "easeOut" },
      });
    }
  }, [bumpNonce, reduce, bumpControls]);

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

  if (w === 0 || h === 0) {
    return null;
  }

  // Size by the smaller stage dimension so the eyes shrink on narrow stages
  // (in portrait, height alone would make them oversized), capped to the stage
  // width so wide eye styles never get cut off sideways.
  const maxEyesW = w * EYE_MAX_WIDTH;
  const eyesH = Math.min(
    Math.min(w, h) * EYE_TARGET_HEIGHT,
    (maxEyesW * art.bbox.h) / art.bbox.w,
  );
  const eyesW = (eyesH * art.bbox.w) / art.bbox.h;
  const eyesLeft = (w - eyesW) / 2;
  const eyesRestTop = h - (1 - EYE_REST_CUTOFF) * eyesH + h * restSinkFraction;
  const eyesStartY = STAGE_CENTER_FRACTION * h - (eyesRestTop + eyesH / 2);
  const eyesDipY = (EYE_DIP_CUTOFF - EYE_REST_CUTOFF) * eyesH;
  const eyeCx = art.bbox.x + art.bbox.w / 2;
  const eyeCy = art.bbox.y + art.bbox.h / 2;

  const eyes = (
    // Slight parallax: the whole eyes drift smoothly toward the cursor.
    <div
      style={{
        transform: `translate(${pointer.x * CURSOR_MAX_X}px, ${pointer.y * CURSOR_MAX_Y}px)`,
        transition: "transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)",
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
            transformOrigin: `${eyeCx}px ${eyeCy}px`,
            transition: "transform 0.14s ease-in-out",
          }}
        >
          {art.paths.map((p, i) => (
            <path key={i} d={p.svgPath} fill={p.color} />
          ))}
        </g>
      </svg>
    </div>
  );

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
      {bumpNonce === undefined ? (
        eyes
      ) : (
        <motion.div animate={bumpControls}>{eyes}</motion.div>
      )}
    </motion.div>
  );
}

/**
 * Fraction of the stage's smaller dimension covered by the eyes' visible
 * portion. Content columns reserve this much at the bottom so foreground
 * controls always clear the eyes.
 */
export const EYES_VISIBLE_FRACTION = EYE_TARGET_HEIGHT * (1 - EYE_REST_CUTOFF);
