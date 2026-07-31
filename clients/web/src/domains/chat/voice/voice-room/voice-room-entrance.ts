/**
 * How the voice room comes and goes, per placement variant.
 *
 * The room's look (the colour fill, the body silhouette, the giant eyes) can
 * introduce itself two ways:
 *
 * - `"grow"`: the onboarding Introduction grow. The body springs from the
 *   avatar the user tapped until it covers the room, the colour fades in behind
 *   it, and the eyes rise into the centre and settle. The room's box holds
 *   still and the look is what moves; closing reverses it, collapsing the whole
 *   shape back toward the tapped control.
 * - `"presented"`: the look is fully painted on its first frame, and the
 *   surface's own chrome carries it on and off. Nothing inside the room
 *   animates itself in.
 *
 * The mobile sheet wants `"presented"`, because it already has an entrance: it
 * slides up. Playing the grow inside it means two animations competing for the
 * same moment: the sheet arrives, and only then does its content assemble
 * itself. It comes up already wearing its colour and eyes instead.
 *
 * This lives outside `voice-room-eyes.tsx` so the choreography is a single
 * thing that can be swapped per surface rather than a `variant` check threaded
 * through every animated layer of the look. The look takes an entrance mode and
 * never learns which variant it is rendering under; a new surface picks a mode
 * here and nothing downstream changes.
 *
 * Desktop (`content`, `fullscreen`) grows, which is what the `entryOrigin`
 * pipeline serves: the live-voice store field, the composer's
 * `measureVoiceOriginAvatar`, `ChatAvatar`'s `originAnchor`, and `toRoomLocal`
 * together give the grow the point to travel from.
 */

import type { MotionProps } from "motion/react";

import { AVATAR_ENTER_SPRING } from "./voice-motion";
import type { VoiceRoomVariant } from "./voice-room";

/** See the module docstring. */
export type VoiceRoomEntrance = "grow" | "presented";

/**
 * Duration of the sheet's slide, mirroring the design library's `bottomSheetIn`
 * keyframe (`packages/design-library/src/tokens.css`). Radix plays that
 * keyframe on open; the exit here has to match it or the sheet leaves at a
 * different speed than it arrived.
 */
const SHEET_SLIDE_SECONDS = 0.18;

/** Room-box fade, used by the variants whose own box is the outermost thing. */
const SHELL_FADE_SECONDS = 0.4;

/**
 * Everything the room needs to know about its own motion, resolved once from
 * the placement variant.
 */
export interface VoiceRoomChoreography {
  /** How the look introduces itself. Passed down to `VoiceRoomColorLook`. */
  entrance: VoiceRoomEntrance;
  /** Motion props for the room's own box. */
  shell: MotionProps;
  /**
   * Motion props for the sheet's chrome, or null for the variants that have no
   * chrome of their own. The sheet's box is Radix's content element, which sits
   * outside the room's box (it is portalled and `fixed`), so the slide has to
   * be applied there: sliding the room's box instead would move the look inside
   * a stationary sheet and expose the page behind it.
   */
  sheetChrome: MotionProps | null;
}

export function resolveVoiceRoomChoreography(
  variant: VoiceRoomVariant,
  reduceMotion: boolean,
): VoiceRoomChoreography {
  const entrance = resolveVoiceRoomEntrance(variant, reduceMotion);
  const sheet = variant === "sheet";
  return {
    entrance,
    shell: shellMotion(sheet, reduceMotion),
    sheetChrome: sheet ? sheetChromeMotion(reduceMotion) : null,
  };
}

/** Which choreography a placement variant uses. See the module docstring. */
export function resolveVoiceRoomEntrance(
  variant: VoiceRoomVariant,
  reduceMotion: boolean,
): VoiceRoomEntrance {
  return withReducedMotion(
    variant === "sheet" ? "presented" : "grow",
    reduceMotion,
  );
}

/**
 * Reduced motion presents, whatever the surface asked for. The look applies
 * this to whatever mode it is handed rather than trusting the caller to have
 * checked, so a surface that renders the look directly (the stories, a future
 * mount) cannot forget to honour the preference.
 */
export function withReducedMotion(
  entrance: VoiceRoomEntrance,
  reduceMotion: boolean,
): VoiceRoomEntrance {
  return reduceMotion ? "presented" : entrance;
}

/**
 * The room's box. Under the sheet it neither fades in nor out: the chrome owns
 * both halves, and a fade layered on top of the slide would dim the look
 * mid-travel.
 */
function shellMotion(sheet: boolean, reduceMotion: boolean): MotionProps {
  if (sheet) {
    return { initial: false };
  }
  return {
    initial: reduceMotion ? false : { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: reduceMotion ? 0 : SHELL_FADE_SECONDS },
  };
}

/**
 * The sheet's chrome. Radix owns the entrance through its
 * `data-[state=open]:animate-[bottomSheetIn]` class, and `initial: false` keeps
 * Motion from fighting it on mount. This owns the exit, which is the same
 * travel in reverse so the sheet leaves the way it came.
 */
function sheetChromeMotion(reduceMotion: boolean): MotionProps {
  return {
    initial: false,
    exit: reduceMotion
      ? // Not a shorter slide: no travel at all, gone on the next frame.
        { opacity: 0, transition: { duration: 0 } }
      : {
          y: "100%",
          opacity: 0,
          transition: { duration: SHEET_SLIDE_SECONDS, ease: "easeIn" },
        },
  };
}

/**
 * The ambient-void look's centred avatar, the fallback for custom-image and
 * "none" avatars, which have no colour or eyes to grow.
 *
 * It has no entry origin to fly from, so its grow is a plain rise-and-scale
 * spring rather than the colour look's travel. Presented, it is simply there:
 * a custom-image assistant should ride the sheet up as settled as a character
 * one does.
 */
export function voidAvatarMotion(entrance: VoiceRoomEntrance): MotionProps {
  if (entrance === "presented") {
    return { initial: false };
  }
  const start = { scale: 0.8, y: 24, opacity: 0 };
  return {
    initial: start,
    animate: { scale: 1, y: 0, opacity: 1 },
    // The inverse of the entry spring: the avatar settles back down and shrinks
    // away rather than fading in place.
    exit: { ...start, transition: { duration: 0.32, ease: "easeIn" } },
    transition: AVATAR_ENTER_SPRING,
  };
}

/** Geometry the grow needs for the body silhouette. See `voice-room-eyes.tsx`. */
export interface BodyGrowGeometry {
  startScale: number;
  startX: number;
  startY: number;
}

/** Geometry the grow needs for the eyes. See `eyeLayout`. */
export interface EyesGrowGeometry {
  startX: number;
  startY: number;
  /** A small settle dip below rest as the eyes land. */
  dipY: number;
}

/** The eyes' resting pose: where `"presented"` starts and the grow ends. */
const EYES_AT_REST = { x: 0, y: 0, scale: 1 };

/**
 * The avatar colour behind the body, which fills the room end to end so
 * coverage survives the gaps and spikes in the body shape.
 *
 * Under the grow it fades in *behind* the growing body, so it is deliberately
 * late (the delay) and slow: leading with it would flood the room with colour
 * before the shape that is supposed to be delivering it has arrived. On close
 * it clears early, so what collapses toward the origin is the body silhouette
 * rather than a shrinking rectangle.
 */
export function colorFillMotion(entrance: VoiceRoomEntrance): MotionProps {
  if (entrance === "presented") {
    return { initial: false };
  }
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0, transition: { duration: 0.2, ease: "easeIn" } },
    transition: { duration: 0.6, delay: 0.35 },
  };
}

/** The body silhouette: springs from "avatar on the screen" to covering it. */
export function bodyGrowMotion(
  entrance: VoiceRoomEntrance,
  geometry: BodyGrowGeometry,
): MotionProps {
  if (entrance === "presented") {
    return { initial: false };
  }
  const start = {
    scale: geometry.startScale,
    x: geometry.startX,
    y: geometry.startY,
  };
  return {
    initial: start,
    animate: { scale: 1, x: 0, y: 0 },
    exit: { ...start, transition: { duration: 0.4, ease: "easeIn" } },
    transition: { type: "spring", stiffness: 78, damping: 18, mass: 1 },
  };
}

/**
 * The eyes' entrance.
 *
 * `entranceDone` matters because the grow is expressed as keyframe *arrays*,
 * and Motion restarts a keyframe animation whenever it is handed a new one. The
 * eyes re-render on every session-state change (`sizeScale`), and a state
 * change lands inside the one-second entrance often (`connecting` to
 * `listening` almost always does), so leaving the arrays in place means the
 * eyes lurch back toward the origin partway and snap forward. Once the entrance
 * lands the caller flips `entranceDone` and this returns a stable static target
 * that re-renders are free to repeat.
 */
export function eyesEntranceMotion(
  entrance: VoiceRoomEntrance,
  geometry: EyesGrowGeometry,
  entranceDone: boolean,
): MotionProps {
  // A presented look neither enters nor leaves under its own power. The exit
  // below belongs to the grow: the eyes shrink back to the entry origin
  // alongside the body, so the whole avatar shape collapses to one point.
  if (entrance === "presented") {
    return {
      initial: false,
      animate: EYES_AT_REST,
      transition: { duration: 0 },
    };
  }
  const start = { x: geometry.startX, y: geometry.startY, scale: 0.35 };
  const playing = !entranceDone;
  return {
    initial: start,
    animate: playing
      ? {
          x: [geometry.startX, 0, 0],
          y: [geometry.startY, geometry.dipY, 0],
          scale: [0.35, 1, 1],
        }
      : EYES_AT_REST,
    exit: {
      ...start,
      opacity: 0,
      transition: { duration: 0.4, ease: "easeIn" },
    },
    transition: playing
      ? { duration: 1, times: [0, 0.7, 1], ease: "easeInOut" }
      : { duration: 0 },
  };
}
