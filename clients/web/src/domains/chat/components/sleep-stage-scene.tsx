/**
 * The sleep stage's picture: the avatar's eyes, their lids, and the line of
 * copy under them. Presentational and self-contained, so the connected
 * `AssistantSleepStage` owns *when* the stage appears and this owns what it
 * looks like while it is up (and Storybook can drive it directly).
 *
 * Three scenes, one continuous face:
 *
 * - `sleeping`: lids well down, drifting a little lower and back, a slow
 *   breath rather than a blink.
 * - `waking`: the same face with more of it showing.
 * - `woke`: the lids retract all the way, the eyes are wide for a beat, and
 *   the stage fades off the conversation it was covering. Motion carries the
 *   lids from wherever they were, so the open is one movement out of the
 *   sleep rather than a cut to a new picture.
 *
 * The stage is always dark. The catalog's sclera is a near-white and so is
 * the light theme's surface, so eyes laid on the light page lose their whites
 * and the pupils float on nothing. The stage re-declares the design tokens
 * under `data-theme="dark"`, the treatment the voice room and the research
 * overlay give their own surfaces, so in light mode the eyes sit on the dark
 * ground they were drawn for and the copy and the close button take light
 * values with it. In dark mode nothing changes.
 *
 * The lid is a slab per eye wearing the eyes' own silhouette (a `clipPath`
 * of the eye paths), so it closes each eye over its top and leaves the gap
 * between them empty. Its lower edge is a shallow arch, higher in the middle
 * than at the ends, the way a lid sits across an eye. It is painted in the
 * avatar's own color, with that edge drawn as a line in a darker shade of the
 * same color: the line is what reads as an eyelid rather than as a color
 * fill stopping halfway down the eye. The line has round ends and runs a few
 * pixels past the eye's outline on each side, a lash line rather than the
 * edge of the fill. It is sized to the eye's width at the height the lid
 * rests (see `pathSpanAt`) so those ends are its own, and it is not clipped
 * with the lid: each eye's line is masked to that eye's outline grown a
 * little past the overhang, which keeps it off the gap between the eyes and
 * takes it away once the lid has slid clear. Lid and lines share one motion,
 * so the edge stays welded to the lid through every drift and the whole way
 * open.
 */

import { X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useId, useMemo } from "react";

import { resolveVoiceRoomLook } from "@/domains/chat/voice/voice-room/voice-room-eyes";
import type { SleepStageScene } from "@/stores/assistant-sleep-stage-store";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { darkenHex } from "@/utils/avatar-tone";
import {
  pathSpanAt,
  tightPathBBox,
  unionBBox,
  type BBox,
} from "@/utils/eye-bbox";

export type { SleepStageScene };

/** The eye art the stage draws, plus the color it closes the lids with. */
export interface SleepStageEyes {
  paths: { svgPath: string; color: string }[];
  bbox: BBox;
  /**
   * One per eye: the path that outlines it, which the lid's edge is drawn
   * across. A pupil sits inside its sclera and is not an eye of its own.
   */
  outlines: { svgPath: string; bbox: BBox }[];
  lidColor: string;
}

/**
 * How much of the eye the lid covers in each scene. An assistant coming back
 * up is further open than one still under, and a woken one is not covered at
 * all.
 */
const LID_REST: Record<SleepStageScene, number> = {
  sleeping: 0.62,
  waking: 0.5,
  woke: 0,
};
/** How much further the lids sink at the bottom of a sleeping drift. */
const LID_DRIFT = 0.12;
/** The lid's edge line, as a share of the eye's height: thick enough for its
 *  round ends to read at the size the stage draws the eyes. */
const LID_EDGE = 0.05;
/**
 * How far the edge line runs past the eye's outline on each side, as a share
 * of the eye's height: a couple of pixels at the size the stage draws the eyes.
 */
const LID_EDGE_SPILL = 0.02;
/**
 * How much higher the lid's edge sits at the middle of the eye than at its
 * ends, as a share of the eye's height: a slight arch, not a curve.
 */
const LID_SAG = 0.05;
/**
 * The line's mask is the outline grown by this much more than the overhang,
 * so the line's round ends survive the drift, which carries the lid to where
 * the eye is a little narrower than where the line was measured.
 */
const LID_EDGE_MASK_SLACK = 1.5;
/** How far the edge band is darkened from the lid's color: enough to read as
 *  an edge, not so much that it cuts the face in two. */
const LID_EDGE_DARKEN = 0.72;
/**
 * Above this width-to-height ratio the eye is a slit rather than a disc, and
 * a lid measured as a share of its height covers the whole thing (`grumpy`,
 * whose art is already a squint, is 4.5:1). The lid eases off in proportion
 * so a shallow eye keeps an eye's worth of ink under it.
 */
const SHALLOW_EYE_ASPECT = 3.2;
/** One full drift, in seconds. */
const LID_DRIFT_SECONDS = 4;

/** The waking beats, in seconds: lids open, eyes hold, stage fades away. */
const WOKE_OPEN_SECONDS = 0.55;
const WOKE_HOLD_SECONDS = 1.1;
const WOKE_FADE_SECONDS = 0.7;

/**
 * How long the `woke` scene runs before the stage is gone. The connected
 * component keeps the stage mounted for exactly this long so the fade lands
 * on the conversation underneath rather than being cut off by an unmount.
 */
export const WOKE_SEQUENCE_MS =
  (WOKE_OPEN_SECONDS + WOKE_HOLD_SECONDS + WOKE_FADE_SECONDS) * 1000;

/**
 * The eye art for an avatar, framed by the box its ink actually occupies.
 *
 * The lid is placed as a share of the eye, so it has to be measured against
 * the ink rather than against the control-point box the peeking eyes frame
 * with (`angry` is drawn with control points nowhere near its curves, and a
 * lid at half of that box covers the whole eye). Returns null for an avatar
 * with no character to draw: an uploaded image, or unknown traits.
 */
export function resolveSleepStageEyes(
  components: CharacterComponents,
  traits: CharacterTraits | null,
  imageUrl: string | null,
): SleepStageEyes | null {
  const look = resolveVoiceRoomLook(components, traits, imageUrl);
  if (!look?.art) {
    return null;
  }
  const boxes = look.art.paths.map((path) => tightPathBBox(path.svgPath));
  const bbox = unionBBox(boxes);
  if (bbox.w <= 0 || bbox.h <= 0) {
    return null;
  }
  // An eye is a path no larger path's box contains: the sclera, not the
  // pupil drawn inside it. Two paths sharing one box count once.
  const outlines = look.art.paths.flatMap((path, i) => {
    const box = boxes[i]!;
    const inner = boxes.some(
      (other, j) =>
        j !== i &&
        contains(other, box) &&
        (area(other) > area(box) || (area(other) === area(box) && j < i)),
    );
    return inner ? [] : [{ svgPath: path.svgPath, bbox: box }];
  });
  return { paths: look.art.paths, bbox, outlines, lidColor: look.bgHex };
}

/** Slack for boxes measured off curves that share an edge. */
const CONTAINS_EPSILON = 0.5;

function contains(outer: BBox, inner: BBox): boolean {
  return (
    outer.x <= inner.x + CONTAINS_EPSILON &&
    outer.y <= inner.y + CONTAINS_EPSILON &&
    outer.x + outer.w >= inner.x + inner.w - CONTAINS_EPSILON &&
    outer.y + outer.h >= inner.y + inner.h - CONTAINS_EPSILON
  );
}

function area(box: BBox): number {
  return box.w * box.h;
}

export interface SleepStageViewProps {
  scene: SleepStageScene;
  /** Null when this assistant has no character to close its eyes. */
  eyes: SleepStageEyes | null;
  /** An uploaded avatar, which stands in when there are no eyes. */
  imageUrl?: string | null;
  /** The line under the eyes, already resolved for the scene and the name. */
  line: string;
  /** The close button's accessible name. */
  dismissLabel: string;
  onDismiss?: () => void;
}

export function SleepStageView({
  scene,
  eyes,
  imageUrl = null,
  line,
  dismissLabel,
  onDismiss,
}: SleepStageViewProps) {
  const reduce = Boolean(useReducedMotion());
  const woke = scene === "woke";

  return (
    <motion.div
      data-scene={scene}
      data-theme="dark"
      className="group absolute inset-0 z-30 flex flex-col items-center justify-center gap-10 rounded-xl bg-[var(--surface-base)] px-6"
      initial={reduce ? false : { opacity: 0 }}
      // Waking runs the whole exit here: the eyes hold open for a beat and
      // then the stage itself fades, so the conversation arrives behind a
      // face that has finished waking rather than behind a cut.
      animate={
        woke && !reduce ? { opacity: [1, 1, 0] } : { opacity: woke ? 0 : 1 }
      }
      transition={
        woke
          ? reduce
            ? { duration: 0.2 }
            : {
                duration: WOKE_SEQUENCE_MS / 1000,
                times: [
                  0,
                  (WOKE_OPEN_SECONDS + WOKE_HOLD_SECONDS) /
                    (WOKE_SEQUENCE_MS / 1000),
                  1,
                ],
                ease: "easeInOut",
              }
          : { duration: reduce ? 0 : 0.35 }
      }
    >
      {eyes ? (
        <StageEyes eyes={eyes} scene={scene} reduce={reduce} />
      ) : imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          aria-hidden="true"
          className="aspect-square w-[clamp(120px,20vw,200px)] rounded-full object-cover opacity-60"
        />
      ) : null}

      {/* The one control on the stage: the surface itself is inert, so a
          stray click on the page it is covering cannot dismiss it by
          accident. Hidden until hover where there is a pointer to hover
          with, and always on where there is not (`(hover: hover)` is false
          on a touch screen), which is the same treatment the attachment
          overlay's download button gets. */}
      {woke ? null : (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="absolute right-4 top-4 flex size-8 cursor-pointer items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--content-secondary)_25%,transparent)] bg-[color-mix(in_srgb,var(--surface-overlay)_70%,transparent)] text-[color:var(--content-secondary)] transition duration-200 hover:border-[color-mix(in_srgb,var(--content-secondary)_45%,transparent)] hover:text-[color:var(--content-default)] focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] active:scale-95 [@media(hover:hover)]:scale-90 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:scale-100 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:scale-100 [@media(hover:hover)]:group-focus-within:opacity-100"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      )}

      {/* The banner stands down while the stage is up, so this line is what
          announces the status: a live region rather than decoration. */}
      <span
        role="status"
        className="block text-center text-[28px] leading-[1.2] tracking-[0.02em] text-[var(--content-emphasised)] md:text-[36px]"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        {line}
      </span>
    </motion.div>
  );
}

function StageEyes({
  eyes,
  scene,
  reduce,
}: {
  eyes: SleepStageEyes;
  scene: SleepStageScene;
  reduce: boolean;
}) {
  const clipId = useId();
  const maskId = useId();
  const { bbox } = eyes;
  // How far the lid has slid down over the eye. The slab hangs above the box
  // with its lower edge at the top of the eye at rest, so one translated
  // value closes the lid, drifts it, and opens it again.
  // Art much wider than it is tall keeps more of itself: see
  // `SHALLOW_EYE_ASPECT`.
  const shallow = Math.min(1, SHALLOW_EYE_ASPECT / (bbox.w / bbox.h));
  const edge = LID_EDGE * bbox.h;
  const spill = LID_EDGE_SPILL * bbox.h;
  const sag = LID_SAG * bbox.h;
  const maskGrow = spill * (1 + LID_EDGE_MASK_SLACK);
  // The lid rests where the scene says; a woken one is measured as if still
  // waking, so its lines are the shape they had a moment before they left.
  const rest = LID_REST[scene === "woke" ? "waking" : scene] * shallow * bbox.h;
  // Open, the lid clears the eye and the edge line clears its mask, so the
  // clip and the masks take all of it.
  const open = -(maskGrow + edge);
  const closed = scene === "woke" ? open : rest;
  const deep = (LID_REST[scene] + LID_DRIFT) * shallow * bbox.h;
  const drifts = scene !== "woke" && !reduce;
  // The overhang and the line's round ends have to fit in the frame.
  const pad = spill + edge / 2;
  const frame: BBox = {
    x: bbox.x - pad,
    y: bbox.y - pad,
    w: bbox.w + pad * 2,
    h: bbox.h + pad * 2,
  };
  const lidMotion = {
    initial: { y: closed },
    animate: drifts ? { y: [closed, deep, closed] } : { y: closed },
    transition: drifts
      ? {
          duration: LID_DRIFT_SECONDS,
          repeat: Infinity,
          ease: "easeInOut" as const,
        }
      : { duration: reduce ? 0 : WOKE_OPEN_SECONDS, ease: "easeOut" as const },
  };

  // Each eye's lid and line, drawn in place over the eye and slid up from
  // there. The line spans the eye where the lid rests, plus its overhang;
  // the lid is that arch with the rest of the slab above it, and reaches
  // past the line's ends so the eye's wider parts above the line are still
  // covered (the clip takes the excess).
  const lids = useMemo(
    () =>
      eyes.outlines.map((outline) => {
        const span = pathSpanAt(outline.svgPath, bbox.y + rest) ?? {
          x0: outline.bbox.x,
          x1: outline.bbox.x + outline.bbox.w,
        };
        const xa = span.x0 - spill;
        const xb = span.x1 + spill;
        const xm = (xa + xb) / 2;
        const yb = bbox.y;
        const yc = yb - sag * 2;
        const far = spill * 4;
        return {
          line: `M${xa} ${yb} Q${xm} ${yc} ${xb} ${yb}`,
          fill: `M${outline.bbox.x - far} ${yb - bbox.h - sag} H${outline.bbox.x + outline.bbox.w + far} V${yb} H${xb} Q${xm} ${yc} ${xa} ${yb} H${outline.bbox.x - far} Z`,
        };
      }),
    [eyes.outlines, bbox, rest, spill, sag],
  );

  return (
    <svg
      aria-hidden="true"
      data-slot="sleep-stage-eyes"
      viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`}
      className="h-auto w-[clamp(140px,26vw,240px)] shrink-0"
    >
      <defs>
        <clipPath id={clipId}>
          {eyes.paths.map((path, i) => (
            <path key={i} d={path.svgPath} />
          ))}
        </clipPath>
        {/* Masks rather than clips for the edge lines: a clip cannot wear a
            stroke, and the stroke is what grows the outline. */}
        {eyes.outlines.map((outline, i) => (
          <mask
            key={i}
            id={`${maskId}-${i}`}
            maskUnits="userSpaceOnUse"
            x={frame.x - maskGrow}
            y={frame.y - maskGrow}
            width={frame.w + maskGrow * 2}
            height={frame.h + maskGrow * 2}
          >
            <path
              d={outline.svgPath}
              fill="white"
              stroke="white"
              strokeWidth={maskGrow * 2}
              strokeLinejoin="round"
            />
          </mask>
        ))}
      </defs>
      {eyes.paths.map((path, i) => (
        <path key={i} d={path.svgPath} fill={path.color} />
      ))}
      {/* The clip and the masks sit on groups of their own: on the moving
          group they would travel with the transform and stop following the
          eye. */}
      <g clipPath={`url(#${clipId})`}>
        <motion.g {...lidMotion}>
          {lids.map((lid, i) => (
            <path
              key={i}
              data-slot="sleep-stage-lid"
              d={lid.fill}
              fill={eyes.lidColor}
            />
          ))}
        </motion.g>
      </g>
      {lids.map((lid, i) => (
        <g key={i} mask={`url(#${maskId}-${i})`}>
          <motion.g {...lidMotion}>
            <path
              data-slot="sleep-stage-lid-edge"
              d={lid.line}
              fill="none"
              stroke={darkenHex(eyes.lidColor, LID_EDGE_DARKEN)}
              strokeWidth={edge}
              strokeLinecap="round"
            />
          </motion.g>
        </g>
      ))}
    </svg>
  );
}
