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
 * The lid is a rectangle wearing the eyes' own silhouette (a `clipPath` of
 * the eye paths), so it closes each eye over its top and leaves the gap
 * between them empty. It is painted in the avatar's own color, which is what
 * makes a closed eye read as that creature's eyelid and not as a grey bar.
 */

import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";

import { resolveVoiceRoomLook } from "@/domains/chat/voice/voice-room/voice-room-eyes";
import type { SleepStageScene } from "@/stores/assistant-sleep-stage-store";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { tightPathBBox, unionBBox, type BBox } from "@/utils/eye-bbox";

export type { SleepStageScene };

/** The eye art the stage draws, plus the color it closes the lids with. */
export interface SleepStageEyes {
  paths: { svgPath: string; color: string }[];
  bbox: BBox;
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
  const bbox = unionBBox(
    look.art.paths.map((path) => tightPathBBox(path.svgPath)),
  );
  if (bbox.w <= 0 || bbox.h <= 0) {
    return null;
  }
  return { paths: look.art.paths, bbox, lidColor: look.bgHex };
}

export interface SleepStageViewProps {
  scene: SleepStageScene;
  /** Null when this assistant has no character to close its eyes. */
  eyes: SleepStageEyes | null;
  /** An uploaded avatar, which stands in when there are no eyes. */
  imageUrl?: string | null;
  /** The line under the eyes, already resolved for the scene and the name. */
  line: string;
  /** Screen-reader-only copy for what clicking the stage does. */
  dismissHint: string;
  onDismiss?: () => void;
}

export function SleepStageView({
  scene,
  eyes,
  imageUrl = null,
  line,
  dismissHint,
  onDismiss,
}: SleepStageViewProps) {
  const reduce = Boolean(useReducedMotion());
  const woke = scene === "woke";

  return (
    <motion.button
      type="button"
      onClick={onDismiss}
      data-scene={scene}
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-10 rounded-xl bg-[var(--surface-base)] px-6"
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

      <span
        className="block text-center text-[28px] leading-[1.2] tracking-[0.02em] text-[var(--content-emphasised)] md:text-[36px]"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        {line}
      </span>
      {/* The button's accessible name is its text, so the status is announced
          before what a click does. No `aria-label`: it would replace the line
          the sighted user reads with the action alone. */}
      <span className="sr-only">{dismissHint}</span>
    </motion.button>
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
  const { bbox } = eyes;
  const rest = LID_REST[scene] * bbox.h;
  const deep = (LID_REST[scene] + LID_DRIFT) * bbox.h;
  const drifts = scene !== "woke" && !reduce;

  return (
    <svg
      aria-hidden="true"
      viewBox={`${bbox.x} ${bbox.y} ${bbox.w} ${bbox.h}`}
      className="h-auto w-[clamp(140px,26vw,240px)] shrink-0"
    >
      <defs>
        <clipPath id={clipId}>
          {eyes.paths.map((path, i) => (
            <path key={i} d={path.svgPath} />
          ))}
        </clipPath>
      </defs>
      {eyes.paths.map((path, i) => (
        <path key={i} d={path.svgPath} fill={path.color} />
      ))}
      <motion.rect
        clipPath={`url(#${clipId})`}
        x={bbox.x}
        y={bbox.y}
        width={bbox.w}
        fill={eyes.lidColor}
        initial={{ height: rest }}
        animate={drifts ? { height: [rest, deep, rest] } : { height: rest }}
        transition={
          drifts
            ? {
                duration: LID_DRIFT_SECONDS,
                repeat: Infinity,
                ease: "easeInOut",
              }
            : {
                duration: reduce ? 0 : WOKE_OPEN_SECONDS,
                ease: "easeOut",
              }
        }
      />
    </svg>
  );
}
