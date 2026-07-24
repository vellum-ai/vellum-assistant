import { motion } from "motion/react";

import {
  DUCK_SCALE,
  EDGE_SINK,
  EYES_RIGHT_OFFSET,
  REST_SCALE,
  SINK_REFERENCE_HEIGHT,
  eyeStyleBaseWidth,
} from "@/utils/assistant-eyes";
import { contrastForeground } from "@/utils/avatar-tone";

/** Flood origin — where the eyes surface, as a percent of the row's width. */
const FLOOD_ORIGIN_X_PERCENT = 88;
/** The growth spurt before ducking, relative to the already-rest-scaled
 *  sprite this overlay renders. */
const DUCK_GROWTH = DUCK_SCALE / REST_SCALE;

/** Duration of the exit phase (grow, duck under, flood drains). Exposed so
 *  the tour sequencer can wait it out before moving to the next stop. */
export const FLOOD_EXIT_MS = 600;

export interface TourEyeArt {
  /** Eye style id, keying the hand-tuned per-style sprite width. */
  id: string;
  paths: { svgPath: string; color: string }[];
  bbox: { x: number; y: number; w: number; h: number };
}

export interface TourTargetRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type TourFloodPhase = "enter" | "exit";

interface TourNavFloodProps {
  rect: TourTargetRect;
  label: string;
  /** Avatar color hex; null floods with a neutral active-surface tone. */
  hex: string | null;
  /** The avatar's eye style; omitted when there's no character avatar. */
  eye: TourEyeArt | null;
  /**
   * `enter`: the flood pours in and the eyes surface through the bottom
   * edge. `exit`: the eyes grow a touch, duck under the fold, and the flood
   * drains — the same leg the assistant cluster's eyes use when hopping
   * from their row to New Chat.
   */
  phase: TourFloodPhase;
}

/**
 * The "avatar is inside this nav item" treatment: a fixed overlay exactly
 * covering the target row that floods with the avatar's color from the spot
 * the eyes surface (mirroring the assistant cluster's New Chat flood).
 */
export function TourNavFlood({ rect, label, hex, eye, phase }: TourNavFloodProps) {
  const fg = hex ? contrastForeground(hex) : "var(--content-strong)";
  // Match the assistant cluster's resting eyes exactly: the per-style base
  // width grown by REST_SCALE, height following the shape's aspect ratio.
  const baseWidth = eye ? eyeStyleBaseWidth(eye.id) : 0;
  const baseHeight = eye ? baseWidth * (eye.bbox.h / eye.bbox.w) : 0;
  const eyesWidth = baseWidth * REST_SCALE;
  const eyesHeight = baseHeight * REST_SCALE;
  /** Bottom-edge sink scales with the shape's (unscaled) height so flatter
   *  variants keep the same visible fraction above the fold. */
  const edgeSink = EDGE_SINK * Math.min(1, baseHeight / SINK_REFERENCE_HEIGHT);
  /** The cluster's eye slot sits at `EYES_RIGHT_OFFSET` pre-scale and grows
   *  from its center, so the rendered sprite's right inset shifts by half
   *  the growth. */
  const eyesRight = EYES_RIGHT_OFFSET + (baseWidth - eyesWidth) / 2;
  /** Fully below the row's fold even at the duck growth spurt. */
  const diveY = rect.height + eyesHeight + 8;
  const entering = phase === "enter";

  return (
    <div
      className="pointer-events-none fixed z-[64] overflow-hidden rounded-[8px]"
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
        initial={{ clipPath: `circle(0% at ${FLOOD_ORIGIN_X_PERCENT}% 100%)` }}
        animate={{
          clipPath: entering
            ? `circle(141% at ${FLOOD_ORIGIN_X_PERCENT}% 100%)`
            : `circle(0% at ${FLOOD_ORIGIN_X_PERCENT}% 100%)`,
        }}
        transition={
          entering
            ? { duration: 0.5, ease: "easeOut" }
            : { duration: 0.35, ease: "easeIn", delay: 0.2 }
        }
      />
      <motion.span
        className="text-body-medium-default absolute inset-y-0 left-0 flex items-center truncate px-[6px]"
        style={{ color: fg, maxWidth: rect.width - eyesRight - eyesWidth }}
        initial={{ opacity: 0 }}
        animate={{ opacity: entering ? 1 : 0 }}
        transition={{ duration: 0.25, delay: entering ? 0.15 : 0.2 }}
      >
        {label}
      </motion.span>
      {eye ? (
        <motion.span
          aria-hidden
          className="absolute"
          style={{
            right: eyesRight,
            bottom: -edgeSink,
            width: eyesWidth,
            height: eyesHeight,
            transformOrigin: "50% 100%",
          }}
          initial={{ y: diveY, scale: 1 }}
          animate={
            entering
              ? { y: 0, scale: 1 }
              : { y: [0, 0, diveY], scale: [1, DUCK_GROWTH, DUCK_GROWTH] }
          }
          transition={
            entering
              ? { type: "spring", stiffness: 360, damping: 16, delay: 0.2 }
              : {
                  duration: FLOOD_EXIT_MS / 1000,
                  times: [0, 0.35, 1],
                  ease: ["easeOut", "easeIn"],
                }
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
