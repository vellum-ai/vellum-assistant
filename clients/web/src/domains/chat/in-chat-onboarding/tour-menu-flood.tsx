import { motion } from "motion/react";

import { REST_SCALE, eyeStyleBaseWidth } from "@/utils/assistant-eyes";

import {
  type TourEyeArt,
  type TourFloodPhase,
  type TourTargetRect,
} from "./tour-nav-flood";

/** Default eye growth over a nav row's resting size — the side-menu beat. */
const DEFAULT_EYES_GROWTH = 3;
/** Default perch, as a fraction of the panel's height. */
const DEFAULT_EYES_Y_FRACTION = 0.9;

interface TourMenuFloodProps {
  /** Viewport rect of the panel being taken over (the side menu, or the
   *  whole page for the intro). */
  rect: TourTargetRect;
  /** Avatar color hex; null floods with a neutral active-surface tone. */
  hex: string | null;
  /** The avatar's eye style; omitted when there's no character avatar. */
  eye: TourEyeArt | null;
  /**
   * `enter`: the flood pours in from the bottom edge and the oversized eyes
   * bounce up to their perch near the bottom. `exit`: the eyes drop back
   * off the bottom edge and vanish (clipped) while the flood drains.
   */
  phase: TourFloodPhase;
  /** Eye size over a nav row's resting size. Defaults to the menu beat's. */
  eyesGrowth?: number;
  /** Eye span as a fraction of the panel's width; overrides `eyesGrowth`
   *  sizing. The eyes stay horizontally centered, so values above 1 clip
   *  the art equally past both side edges — 1.25 cuts 10% off each side. */
  eyesWidthFraction?: number;
  /** Fraction of the eye art's height clipped below the panel's bottom
   *  edge; overrides the `eyesYFraction` perch when set. */
  eyesBottomCutFraction?: number;
  /** Eye perch, as a fraction of the panel's height. */
  eyesYFraction?: number;
  /** Rounded panel corners (the side menu); the full-page beat squares off. */
  rounded?: boolean;
  /** Stacking class — the intro's full-page flood sits UNDER the narration
   *  overlay so the typed text reads on top of the color. */
  zClassName?: string;
}

/**
 * The "avatar takes over this panel" treatment: an overlay covering the
 * target rect that floods with the avatar's color while an oversized pair
 * of its eyes bounces up through the bottom edge to a perch near the
 * bottom. Sized per beat — the side menu, or the entire page for the intro.
 */
export function TourMenuFlood({
  rect,
  hex,
  eye,
  phase,
  eyesGrowth = DEFAULT_EYES_GROWTH,
  eyesWidthFraction,
  eyesBottomCutFraction,
  eyesYFraction = DEFAULT_EYES_Y_FRACTION,
  rounded = true,
  zClassName = "z-[64]",
}: TourMenuFloodProps) {
  const baseWidth = eye ? eyeStyleBaseWidth(eye.id) : 0;
  const aspect = eye ? eye.bbox.h / eye.bbox.w : 0;
  const eyesWidth =
    eyesWidthFraction != null
      ? rect.width * eyesWidthFraction
      : baseWidth * REST_SCALE * eyesGrowth;
  const eyesHeight = eyesWidth * aspect;
  const entering = phase === "enter";

  /** Resting top edge of the art when anchored by the bottom cut. */
  const eyesTop =
    eyesBottomCutFraction != null
      ? rect.height - eyesHeight * (1 - eyesBottomCutFraction)
      : null;

  /** Rise-in travel: from just under the panel's bottom edge to the perch. */
  const enterFromY =
    eyesBottomCutFraction != null
      ? eyesHeight * (1 - eyesBottomCutFraction)
      : rect.height * (1 - eyesYFraction) + eyesHeight;
  /** Exit travel: back down past the bottom edge, where the overlay clips
   *  them. */
  const exitToY = enterFromY;

  return (
    <div
      className={`pointer-events-none fixed overflow-hidden ${zClassName} ${
        rounded ? "rounded-xl" : ""
      }`}
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }}
    >
      <motion.div
        className="absolute inset-0"
        style={{ background: hex ?? "var(--surface-active)" }}
        initial={{ clipPath: "circle(0% at 50% 100%)" }}
        animate={{
          clipPath: entering
            ? "circle(141% at 50% 100%)"
            : "circle(0% at 50% 100%)",
        }}
        transition={
          entering
            ? { duration: 0.6, ease: "easeOut" }
            : { duration: 0.45, ease: "easeIn", delay: 0.2 }
        }
      />
      {eye ? (
        <motion.span
          aria-hidden
          className="absolute"
          style={{
            left: "50%",
            top: eyesTop ?? `${eyesYFraction * 100}%`,
            marginLeft: -eyesWidth / 2,
            marginTop: eyesTop != null ? 0 : -eyesHeight / 2,
            width: eyesWidth,
            height: eyesHeight,
            transformOrigin: "50% 50%",
          }}
          initial={{ y: enterFromY, scale: 1 }}
          animate={entering ? { y: 0, scale: 1 } : { y: exitToY, scale: 1 }}
          transition={
            entering
              ? { type: "spring", stiffness: 280, damping: 13, delay: 0.2 }
              : { duration: 0.45, ease: "easeIn" }
          }
        >
          <svg
            viewBox={`${eye.bbox.x} ${eye.bbox.y} ${eye.bbox.w} ${eye.bbox.h}`}
            width="100%"
            height="100%"
            preserveAspectRatio="xMidYMid meet"
            style={{ overflow: "visible", display: "block" }}
          >
            {eye.paths.map((p, i) => (
              <path key={i} d={p.svgPath} fill={p.color} />
            ))}
          </svg>
        </motion.span>
      ) : null}
    </div>
  );
}
