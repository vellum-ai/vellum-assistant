/**
 * The color look for the voice room — the onboarding "avatar is the screen"
 * treatment reused for character avatars.
 *
 * `resolveVoiceRoomLook` maps the assistant's avatar data to the look; the
 * {@link VoiceRoomColorLook} component plays the onboarding Introduction
 * step's entrance on mount, so opening the room reads as the avatar growing
 * from "on the screen" to BEING the screen, unless the surface already has an
 * entrance of its own, in which case the look is simply painted and rides it.
 * Which one a surface gets is `voice-room-entrance.ts`'s call, arriving here as
 * the `entrance` prop; the steps below describe the grow:
 *
 * 1. the room starts on a dark surface,
 * 2. the avatar's body shape springs from its small on-screen size up to
 *    cover the viewport end to end,
 * 3. the matching color layer fades in behind it (covering the body shape's
 *    gaps/spikes),
 * 4. the giant eyes grow into their rest position (bottom-edge or centered,
 *    per `eyePlacement`) with a settle dip, then a double blink and idle-blink
 *    from there (with a slight cursor parallax).
 *
 * Per-state treatments (driven by `visual`, cross-faded so nothing pops): the
 * eyes stay centered throughout and express the state by *size* — a smooth
 * scale tween, no vertical travel. While the user speaks (`listening`) the
 * mic-amplitude waveform sweeps in from the top edge (clear of the centered
 * eyes) and the eyes open wide (large — all ears). When the turn passes to the
 * assistant, `thinking` shrinks them small and a quiet dot triad works away
 * just above them, then `responding` settles them to a medium size while the
 * assistant's voice radiates outward from behind them (see
 * {@link VoiceRespondingStyle}). A soft state caption ("Listening" / "Thinking"
 * / "Speaking") fades in down in the room's lower text zone (see
 * `voice-room-layout.ts`), naming the beat from the same baseline the
 * assistant's own speech would occupy. `reconnecting` fades the eyes back —
 * presence dimmed while away.
 *
 * Geometry and timing mirror onboarding's `IntroductionScreen` +
 * `OnboardingPeekingEyes`. Traits default like `ChatAvatar` does (first
 * component of each type), so a default-character assistant gets the same
 * color and eyes the user sees in its small avatar. Custom-image /
 * no-character avatars resolve to `null` and the room falls back to its
 * ambient-void look — what that look should become is an open design
 * question.
 *
 * Decorative: `aria-hidden`, `pointer-events-none`, reduced-motion safe. It
 * resolves to the presented entrance (no grow), and drops the parallax; the
 * blink is a discrete squish, kept.
 *
 * Everything here is sized against the box it is given, not the window. The
 * room is an inset panel on desktop (see `voice-room.tsx`), so "the screen" the
 * avatar grows to BE is the panel; the room measures itself and passes that
 * box, and Storybook passes its frame. `useViewportSize` remains only as the
 * fallback for callers that render at full-viewport scale.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useAnimationControls,
  useReducedMotion,
} from "motion/react";

import { pathBBox, unionBBox, type BBox } from "@/utils/eye-bbox";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

import {
  VoiceListeningWaves,
  type VoiceWavePalette,
  type VoiceWavePlacement,
  type VoiceWaveStyle,
} from "./voice-listening-waves";
import type { VoiceAvatarVisual } from "./voice-avatar-state";
import {
  bodyGrowMotion,
  colorFillMotion,
  eyesEntranceMotion,
  withReducedMotion,
  type VoiceRoomEntrance,
} from "./voice-room-entrance";
import { createAmplitudeSmoother } from "./voice-motion";
import { useReactiveEyes, type VoiceEyeReaction } from "./use-reactive-eyes";
import { VoiceReactiveWaves } from "./voice-reactive-waves";
import { VoiceMeshWaves } from "./voice-mesh-waves";
import {
  VOICE_ROOM_CAPTION_TEXT,
  VOICE_ROOM_LOWER_ZONE_BOTTOM,
} from "./voice-room-layout";

/** Where the eyes come to rest: cut off at the bottom edge, or centered. */
export type VoiceEyePlacement = "bottom" | "center";

/** How much of the bottom-placed eyes sits below the edge at rest. */
const EYE_REST_CUTOFF = 0.25;
/** Eye sizing: height at most 22% of the smaller viewport dimension, clamped so
 *  width stays on-screen (≤60% of viewport width) and — so the eyes don't loom
 *  large enough to feel intimidating on big displays — capped at an absolute
 *  `EYE_MAX_HEIGHT_PX` ceiling. Scale with the screen, up to a maximum. */
const EYE_TARGET_HEIGHT = 0.22;
const EYE_MAX_WIDTH = 0.6;
const EYE_MAX_HEIGHT_PX = 240;
/**
 * Slight whole-eye cursor parallax — a trace of life, not gaze tracking. Kept
 * small, and smaller on X than on Y: the eyes are the room's vertical spine and
 * every other centered element (the state caption, the thinking triad, both
 * transcript zones) shares that axis, so horizontal drift reads as the eyes
 * sitting *misaligned* with the text rather than as them following the cursor.
 */
const CURSOR_MAX_X = 4;
const CURSOR_MAX_Y = 3;
/**
 * Per-state eye size, as a scale of the rest geometry (which is authored at the
 * largest, `listening`, size). The eyes never move — they open wide when the
 * user speaks (all ears), shrink small while the assistant thinks (withdrawn,
 * working), and settle to a medium size while it speaks (engaged). `idle` /
 * `reconnecting` rest a touch under full. Retargeted by a scale tween, so the
 * state change reads as the eyes breathing rather than sliding.
 */
const EYE_STATE_SCALE: Record<VoiceAvatarVisual, number> = {
  idle: 0.9,
  listening: 1,
  thinking: 0.62,
  responding: 0.8,
  reconnecting: 0.9,
};
/** How long the eyes take to resize between states. */
const EYE_RESIZE_MS = 500;

/**
 * Which audio gesture the eyes express per session phase. Only the two states
 * that actually carry audio react: `listening` follows the mic, `responding`
 * follows the TTS output. `thinking` is deliberately still — there is no sound
 * to answer, and a reaction there would be animating noise.
 */
const EYE_REACTION: Record<VoiceAvatarVisual, VoiceEyeReaction> = {
  idle: null,
  listening: "listening",
  thinking: null,
  responding: "responding",
  reconnecting: null,
};

/**
 * Which wave band the room draws.
 *
 * `reactive` rebuilds the filled wave geometry every frame from a rolling
 * history of the live amplitude, so the terrain is a record of what was
 * actually said. `mesh` draws the same signal as a woven wireframe sheet —
 * dozens of phase-shifted hairlines on a canvas, brightening where they cross.
 * `sine` is the original fixed-geometry band, kept so the alternatives can be
 * compared against it in Storybook — its silhouette is authored once at mount
 * and only slid sideways, which is what made the room read as a static image.
 */
export type VoiceWaveEngine = "reactive" | "mesh" | "sine";

/** Draw the listening band with whichever engine the caller selected. */
function WaveBand({
  engine,
  waveStyle,
  color,
  peakOpacity,
  opacityKnee,
  ...props
}: {
  engine: VoiceWaveEngine;
  getAmplitude: () => number;
  waveStyle?: VoiceWaveStyle;
  palette?: VoiceWavePalette;
  placement?: VoiceWavePlacement;
  /** Mesh-only: explicit ink, its opacity ceiling, and how fast that ceiling
   *  is reached. See {@link BAND_VOICE}. */
  color?: string;
  peakOpacity?: number;
  opacityKnee?: number;
}) {
  // The mesh is stroked hairlines by construction, so fill-vs-line does not
  // apply to it; the filled bands in turn take their color from the palette
  // CSS and have nowhere to put an explicit ink.
  if (engine === "mesh") {
    return (
      <VoiceMeshWaves
        {...props}
        color={color}
        peakOpacity={peakOpacity}
        tuning={opacityKnee === undefined ? undefined : { opacityKnee }}
      />
    );
  }
  return engine === "reactive" ? (
    <VoiceReactiveWaves waveStyle={waveStyle} {...props} />
  ) : (
    <VoiceListeningWaves waveStyle={waveStyle} {...props} />
  );
}
/** State caption shown below the eyes, per visual (none for idle / connecting-
 *  side states, which the room's own connect label covers). */
const EYE_STATE_CAPTION: Partial<Record<VoiceAvatarVisual, string>> = {
  listening: "Listening",
  thinking: "Thinking",
  responding: "Speaking",
};
/** The entrance grows the body from this "avatar on the screen" size and the
 *  eyes from this vertical center — onboarding's picker geometry. */
const ENTER_FROM_SIZE = 200;
const ENTER_FROM_CENTER_VH = 40;
/**
 * The room's own dark base, under the color fade (matches the ambient look's
 * deep surface so the first frames read the same for both looks).
 *
 * Exported as the surface any voice surface paints when the assistant has no
 * character color to borrow, which is what `resolveVoiceRoomLook` returning
 * null means: custom-image and "none" avatars. The minimized composer bar
 * shares it so a colorless assistant minimizes into the same deep surface the
 * room shows it on.
 */
export const VOICE_SURFACE_DARK = "#17191C";
const DARK_SURFACE = VOICE_SURFACE_DARK;

export interface VoiceRoomEyeArt {
  paths: { svgPath: string; color: string }[];
  bbox: BBox;
}

export interface VoiceRoomLook {
  /** The avatar color that fills the room. */
  bgHex: string;
  /** The avatar's eye art, sized/framed by its union bounding box. */
  art: VoiceRoomEyeArt;
  /** The avatar's body shape, grown to cover the screen on entrance. */
  body: { svgPath: string; viewBox: { width: number; height: number } } | null;
}

/**
 * Resolve the room's color-with-eyes look from the session assistant's avatar
 * data, or `null` when the assistant has no character to draw (custom-image /
 * "none" avatars, or components/traits still loading) — the caller then keeps
 * the ambient-void look.
 */
export function resolveVoiceRoomLook(
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
  customImageUrl: string | null,
): VoiceRoomLook | null {
  if (!components) {
    return null;
  }
  // A custom uploaded image with no traits renders as the image avatar, not a
  // character — same precedence as ChatAvatar's `preferCharacter`.
  if (!traits && customImageUrl) {
    return null;
  }
  const effectiveTraits =
    traits ??
    (components.bodyShapes[0] && components.eyeStyles[0] && components.colors[0]
      ? {
          bodyShape: components.bodyShapes[0].id,
          eyeStyle: components.eyeStyles[0].id,
          color: components.colors[0].id,
        }
      : null);
  if (!effectiveTraits) {
    return null;
  }
  const eyeDef = components.eyeStyles.find(
    (e) => e.id === effectiveTraits.eyeStyle,
  );
  const bgHex = components.colors.find(
    (c) => c.id === effectiveTraits.color,
  )?.hex;
  if (!eyeDef || eyeDef.paths.length === 0 || !bgHex) {
    return null;
  }
  const bbox = unionBBox(eyeDef.paths.map((p) => pathBBox(p.svgPath)));
  // Degenerate art (empty paths) would make the sizing math divide by zero.
  if (bbox.w <= 0 || bbox.h <= 0) {
    return null;
  }
  const bodyDef = components.bodyShapes.find(
    (b) => b.id === effectiveTraits.bodyShape,
  );
  const body =
    bodyDef && bodyDef.viewBox.width > 0 && bodyDef.viewBox.height > 0
      ? { svgPath: bodyDef.svgPath, viewBox: bodyDef.viewBox }
      : null;
  return { bgHex, art: { paths: eyeDef.paths, bbox }, body };
}

/**
 * The on-screen height of the eyes in a `w`×`h` room — capped at
 * `EYE_TARGET_HEIGHT` of the smaller dimension, clamped so the width stays
 * within `EYE_MAX_WIDTH`, and finally bounded by the absolute
 * `EYE_MAX_HEIGHT_PX` ceiling so the eyes stop growing on large displays.
 * Shared so the thinking dots can sit just above the centered eyes without
 * re-deriving the sizing from the art bbox.
 */
function eyeDisplayHeight(art: VoiceRoomEyeArt, w: number, h: number): number {
  const maxEyesW = w * EYE_MAX_WIDTH;
  return Math.min(
    Math.min(w, h) * EYE_TARGET_HEIGHT,
    (maxEyesW * art.bbox.h) / art.bbox.w,
    EYE_MAX_HEIGHT_PX,
  );
}

function windowSize(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * The window box, kept live on resize. The fallback for callers that render at
 * full-viewport scale. The room itself measures its own panel and passes it in
 * as `viewport`; see `use-room-box.ts`.
 */
function useViewportSize(): { w: number; h: number } {
  const [size, setSize] = useState(windowSize);
  useEffect(() => {
    const onResize = () => setSize(windowSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/**
 * The full color look: dark base, screen-covering body grow, color fade,
 * listening waves, peeking eyes. Mount = session start (the room only mounts
 * once per session), so mounting plays the entrance.
 */
export function VoiceRoomColorLook({
  look,
  visual = "idle",
  getAmplitude,
  getResponseAmplitude,
  respondingStyle = "waves",
  eyePlacement = "center",
  wavePlacement = "bottom",
  wavePalette = "tone",
  waveStyle = "fill",
  showStateCaption = true,
  captionEmphasis = "hidden",
  entryOrigin = null,
  entrance: requestedEntrance = "grow",
  waveEngine = "mesh",
  viewport,
}: {
  look: VoiceRoomLook;
  /** Session phase — drives which per-state treatment the look shows. */
  visual?: VoiceAvatarVisual;
  /** Mic (input) amplitude source (0–1) — the listening waveform + eye bob. */
  getAmplitude?: () => number;
  /** TTS (output) amplitude source (0–1) — the responding treatment. Falls
   *  back to {@link getAmplitude} when omitted. */
  getResponseAmplitude?: () => number;
  /** Which responding-state treatment to show (sketch knob). */
  respondingStyle?: VoiceRespondingStyle;
  eyePlacement?: VoiceEyePlacement;
  wavePlacement?: VoiceWavePlacement;
  wavePalette?: VoiceWavePalette;
  waveStyle?: VoiceWaveStyle;
  /** Show the state caption below the eyes. Off when the room's live captions
   *  are on — the transcript already names/fills that space. */
  showStateCaption?: boolean;
  /** How prominent that caption is while audio flows. See {@link VoiceCaptionEmphasis}. */
  captionEmphasis?: VoiceCaptionEmphasis;
  /** Point the entrance grows from (the tapped control), in ROOM-LOCAL space.
   *  the caller converts from the viewport point it captured. Null → the fixed
   *  room-center origin. Unread when {@link entrance} is `"presented"`. */
  entryOrigin?: { x: number; y: number } | null;
  /** How the look introduces itself. See `voice-room-entrance.ts`. Defaults to
   *  the grow; a surface with an entrance of its own passes `"presented"`. */
  entrance?: VoiceRoomEntrance;
  /** Which wave band to draw. See {@link VoiceWaveEngine}. */
  waveEngine?: VoiceWaveEngine;
  /** The room box to lay out against. The room measures its own panel and
   *  passes it; omitted, this falls back to the window. */
  viewport?: { w: number; h: number };
}) {
  const reduce = useReducedMotion();
  const measured = useViewportSize();
  const { w, h } = viewport ?? measured;
  const entrance = withReducedMotion(requestedEntrance, reduce === true);

  // Where the entrance grows from: the tapped control's point in room-local
  // space, or the fixed picker-height room center when none was captured (or in
  // Storybook).
  const origin = entryOrigin ?? {
    x: w / 2,
    y: (ENTER_FROM_CENTER_VH / 100) * h,
  };

  // Per-state treatments. The waveform is the user's live voice (listening
  // only). The eyes never move — they stay centered and express the state by
  // size (`EYE_STATE_SCALE`): wide while the user speaks, small while thinking,
  // medium while speaking. The centered eyes are framed at the full (listening)
  // size; `centeredEyeTop` is that frame's top edge.
  const showWaves = visual === "listening";
  const sizeScale = EYE_STATE_SCALE[visual];
  const eyeH = eyeDisplayHeight(look.art, w, h);
  const centeredEyeTop = (h - eyeH) / 2;
  // Spatial model (shared with both text zones — see `voice-room-layout.ts`):
  // above the eyes is the user's space (the user transcript), below is the
  // assistant's (its speech + status). The thinking dots are assistant
  // activity, so they hang just *below* the shrunken thinking eyes — clear of
  // the user transcript above, and pairing with the state caption further down
  // the lower zone. (Centered scaling, so the small eyes' bottom sits above the
  // full-size bottom by half the size loss.)
  const thinkingEyeBottom =
    centeredEyeTop + eyeH - (eyeH * (1 - EYE_STATE_SCALE.thinking)) / 2;

  // Body grows to cover the screen end to end, from the small avatar size at
  // the entry origin — onboarding's Introduction grow, re-anchored to where the
  // user tapped. The body's rest center is the screen center (w/2, h/2), so it
  // starts offset by (origin − center) and slides to 0.
  const bodyGeometry = useMemo(() => {
    // A degenerate box (a not-yet-laid-out panel, a test renderer that reports
    // no extent) would make `startScale` divide by zero and hand Motion an
    // `Infinity` scale. Skip the body grow rather than animate garbage. The
    // color fill still covers the room.
    if (!look.body || w <= 0 || h <= 0) {
      return null;
    }
    const coverSize = 1.25 * Math.max(w, h);
    const coverH =
      (coverSize * look.body.viewBox.height) / look.body.viewBox.width;
    return {
      coverSize,
      coverH,
      left: (w - coverSize) / 2,
      top: (h - coverH) / 2,
      startScale: ENTER_FROM_SIZE / coverSize,
      startX: origin.x - w / 2,
      startY: origin.y - h / 2,
    };
  }, [look.body, w, h, origin.x, origin.y]);

  return (
    <>
      {/* Dark base, so the grow has something to happen over. */}
      <div
        className="absolute inset-0"
        style={{ backgroundColor: DARK_SURFACE }}
      />

      {/* The avatar color fills in behind the body so coverage is end-to-end
          even where the body shape has gaps/spikes. On close it clears early so
          the shrinking body silhouette — not the full-screen rectangle — is what
          collapses into the origin. */}
      <motion.div
        className="absolute inset-0"
        style={{ backgroundColor: look.bgHex }}
        {...colorFillMotion(entrance)}
      />

      {/* Body — springs from "avatar on the screen" to covering it. */}
      {look.body && bodyGeometry ? (
        <motion.svg
          aria-hidden="true"
          className="pointer-events-none absolute"
          viewBox={`0 0 ${look.body.viewBox.width} ${look.body.viewBox.height}`}
          width={bodyGeometry.coverSize}
          height={bodyGeometry.coverH}
          style={{
            left: bodyGeometry.left,
            top: bodyGeometry.top,
            transformOrigin: "center",
          }}
          {...bodyGrowMotion(entrance, bodyGeometry)}
        >
          <path d={look.body.svgPath} fill={look.bgHex} />
        </motion.svg>
      ) : null}

      {/* Per-state treatment layer — the listening waves, the thinking dots,
          and the responding treatment cross-fade as the session moves between
          states (only one is live at a time), so nothing pops in or vanishes
          hard. The listening→thinking hand-off in particular reads as the waves
          dissolving out and the dots dissolving in while the eyes ride up. */}
      <AnimatePresence>
        {/* The user's voice, gathering behind the eyes while they speak. */}
        {showWaves && getAmplitude ? (
          <motion.div
            key="listening"
            className="pointer-events-none absolute inset-0"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.3 }}
          >
            <WaveBand
              engine={waveEngine}
              getAmplitude={getAmplitude}
              waveStyle={waveStyle}
              palette={wavePalette}
              placement={wavePlacement}
              color={BAND_VOICE.listening.color}
              peakOpacity={BAND_VOICE.listening.peakOpacity}
              opacityKnee={BAND_VOICE.listening.opacityKnee}
            />
          </motion.div>
        ) : null}

        {/* Thinking: the eyes have ridden back up to center; a quiet dot triad
            works away just above them. */}
        {visual === "thinking" ? (
          <motion.div
            key="thinking"
            className="pointer-events-none absolute inset-0"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.3 }}
          >
            <VoiceThinkingIndicator
              viewport={{ w, h }}
              eyesBottom={thinkingEyeBottom}
            />
          </motion.div>
        ) : null}

        {/* Responding: the eyes stay centered (engaged, addressing the user)
            and the assistant's voice radiates outward from behind them, driven
            by the TTS-output amplitude — energy going out, the mirror of
            listening's incoming waves. */}
        {visual === "responding" ? (
          <motion.div
            key="responding"
            className="pointer-events-none absolute inset-0"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.3 }}
          >
            <VoiceRespondingTreatment
              style={respondingStyle}
              engine={waveEngine}
              getAmplitude={getResponseAmplitude ?? getAmplitude}
              waveStyle={waveStyle}
              wavePlacement={wavePlacement}
              wavePalette={wavePalette}
              viewport={{ w, h }}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <VoiceRoomEyes
        art={look.art}
        placement={eyePlacement}
        viewport={{ w, h }}
        entranceOrigin={origin}
        entrance={entrance}
        // The centered eyes never move — they express the state by size.
        sizeScale={sizeScale}
        // Reconnecting: fade the eyes back — presence dimmed while away.
        dimmed={visual === "reconnecting"}
        // Audio reaction on top of the size tween: the eyes widen with the
        // user's mic while listening and pulse with the assistant's own voice
        // while responding, so they stay alive through a turn instead of
        // holding one pose for its whole duration.
        eyeReaction={EYE_REACTION[visual]}
        getAmplitude={
          visual === "responding"
            ? (getResponseAmplitude ?? getAmplitude)
            : getAmplitude
        }
      />

      {/* State caption in the room's lower zone (unless the live captions are
          on — the assistant transcript occupies that zone instead). */}
      {showStateCaption ? (
        <VoiceStateCaption visual={visual} emphasis={captionEmphasis} />
      ) : null}
    </>
  );
}

/**
 * Soft state caption ("Listening" / "Thinking" / "Speaking") in the room's
 * lower text zone, in the room's foreground tone. Cross-fades on state change
 * and simply isn't there for states without a caption
 * ({@link EYE_STATE_CAPTION}) — idle and the connecting-side states, which the
 * room's own connect label already covers.
 *
 * Anchored to {@link VOICE_ROOM_LOWER_ZONE_BOTTOM}, the assistant's zone, so
 * the caption names the assistant's beat from the same baseline the
 * assistant's own speech occupies — the two never coexist (the caption stands
 * down when live captions are on), so one baseline serves both rather than
 * splitting the room's text across two regions. Holding it clear of the
 * centerpiece also keeps it from reading as a facial feature: a caption sat
 * just under the eyes reads as a mouth, which suits "Speaking" and contradicts
 * "Listening", where the *user* is the one talking.
 *
 * Both looks share this anchor, so the caption reads in the same place
 * regardless of avatar type.
 */
/**
 * How loudly the room states the phase in words.
 *
 * The caption existed to name beats the visuals could not. Every phase now has
 * a band of its own — the mic at the ceiling, the reply at the floor, and the
 * hand-off sweeping between them — so the words were repeating what the screen
 * already showed while competing with the transcript for the same lower zone.
 * `hidden` (the default) drops the caption and lets the animation carry the
 * state alone; `muted` keeps it as a small dim label; `full` is the original
 * weight.
 *
 * Applies uniformly across phases. It did once exempt `thinking`, back when
 * that state had nothing but a dot triad and dropping its caption would have
 * left a still, silent room — {@link VoiceThinkingBand} is what removed the
 * need for the exception.
 */
export type VoiceCaptionEmphasis = "full" | "muted" | "hidden";

/** Scale + opacity applied to the caption per emphasis, while audio flows. */
const CAPTION_EMPHASIS: Record<
  VoiceCaptionEmphasis,
  { scale: number; opacity: number } | null
> = {
  full: { scale: 1, opacity: 1 },
  muted: { scale: 0.72, opacity: 0.55 },
  hidden: null,
};

/**
 * How each voice's band is inked.
 *
 * Both sit on the floor. An earlier pass told them apart by *position* — the
 * mic at the ceiling, the reply at the bottom — which read well but meant the
 * room's whole composition rearranged itself twice a turn. Keeping both at the
 * same edge and separating them by ink instead holds the layout still: the
 * user's voice lifts a pale sheet off the floor, the assistant's answers in a
 * darker one, and the eyes never have to share the frame with a band overhead.
 *
 * The two are deliberately not symmetric, because dark ink and pale ink do not
 * behave the same way on a mid-tone background:
 *
 * - **Opacity ceiling.** Black at 0.2 is nowhere near "half as present" as
 *   white at 0.4 — light-on-midtone is a far bigger luminance step than
 *   dark-on-midtone at equal alpha, so the dark band needs a higher number to
 *   land in the same perceptual place.
 * - **`opacityKnee`.** The pale band's *silhouette* reads clearly, so opacity
 *   can saturate early and let displacement carry the dynamics. The dark
 *   band's silhouette is low-contrast, so opacity is doing most of the visible
 *   work — saturating it early made the assistant's voice look like it had
 *   stopped responding to amplitude at all. It stays closer to linear.
 *
 * Both still reach zero in silence, so the floor is empty between turns.
 *
 * Exported because every painted voice surface inks its band this way, not just
 * the room: the fill is the avatar color, so a band tinted with the avatar
 * accent is the fill's own hue and paints nothing visible on it. The minimized
 * composer block borrows both entries for the same reason the room has them.
 */
export const BAND_VOICE = {
  listening: { color: "#FFFFFF", peakOpacity: 0.4, opacityKnee: 3 },
  responding: { color: "#000000", peakOpacity: 0.45, opacityKnee: 1.3 },
} as const;

export function VoiceStateCaption({
  visual,
  emphasis = "hidden",
}: {
  visual: VoiceAvatarVisual;
  emphasis?: VoiceCaptionEmphasis;
}) {
  const reduce = useReducedMotion();
  const label = EYE_STATE_CAPTION[visual];
  const treatment = CAPTION_EMPHASIS[emphasis];
  return (
    <AnimatePresence mode="wait">
      {label && treatment ? (
        <motion.div
          key={label}
          data-testid="voice-state-caption"
          data-emphasis={emphasis}
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 z-[1] -translate-x-1/2 text-center font-medium tracking-wide text-[var(--room-fg-muted,rgba(255,255,255,0.7))]"
          style={{
            bottom: VOICE_ROOM_LOWER_ZONE_BOTTOM,
            // Scale the type rather than transform the box, so the caption
            // stays on the lower zone's baseline instead of drifting off it.
            fontSize: `calc(${VOICE_ROOM_CAPTION_TEXT} * ${treatment.scale})`,
          }}
          initial={reduce ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: treatment.opacity, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
          transition={{ duration: reduce ? 0 : 0.28, ease: "easeOut" }}
        >
          {label}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * Thinking indicator — a soft triad of dots pulsing in sequence just below the
 * centered eyes (the lower "assistant status" zone, clear of the user
 * transcript above), in the room's foreground tone so it reads on any avatar
 * color. `eyesBottom` is the bottom of the shrunken thinking eyes; the triad
 * hangs a short gap below it (scaled against the room box) so it stays clear of
 * the eyes in any frame, while the dots themselves are scaled against the state
 * caption's type size. A first-pass "the assistant is working" motif.
 */
function VoiceThinkingIndicator({
  viewport,
  eyesBottom,
}: {
  viewport: { w: number; h: number };
  /** Bottom edge (px) of the centered eyes — the triad hangs below this. */
  eyesBottom: number;
}) {
  const reduce = useReducedMotion();
  // Hang the triad's center a short gap below the eyes' bottom edge. The gap
  // scales with the room box, NOT with the dot size, so the two stay
  // independent. Clamped so it never rides off the bottom of a short frame.
  const top = Math.min(
    viewport.h - 24,
    eyesBottom + 0.06 * Math.min(viewport.w, viewport.h),
  );
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 z-[1] flex -translate-x-1/2 -translate-y-1/2 items-center"
      // Dots are sized in `em` off the caption's own type size, so the triad
      // reads as a peer of the "Thinking" caption below it and the two stay
      // locked to each other at every viewport.
      style={{ top, fontSize: VOICE_ROOM_CAPTION_TEXT, gap: "0.45em" }}
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block rounded-full"
          style={{
            width: "0.5em",
            height: "0.5em",
            backgroundColor: "var(--room-fg, #ffffff)",
          }}
          initial={reduce ? false : { opacity: 0.3, scale: 0.75 }}
          animate={
            reduce
              ? { opacity: 0.6 }
              : { opacity: [0.3, 1, 0.3], scale: [0.75, 1, 0.75] }
          }
          transition={
            reduce
              ? { duration: 0 }
              : {
                  duration: 1.1,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: i * 0.18,
                }
          }
        />
      ))}
    </div>
  );
}

/**
 * Candidate responding-state treatments (sketches to compare in Storybook):
 * - `rings`    — concentric rings expanding outward from behind the eyes,
 *                the mirror of listening's incoming waves (energy going out).
 * - `halo`     — a soft radial bloom around the eyes that swells with speech.
 * - `waveform` — the centered waveform again, now the assistant's own voice.
 * - `pulse`    — the whole color field brightens gently on speech peaks.
 * All ride the TTS-output amplitude and tint from the room foreground tone.
 */
/**
 * How the assistant's voice is drawn while it speaks.
 *
 * `waves` is the spatial counterpart to the listening band: the user's voice
 * arrives from the ceiling, the assistant's answers from the floor, so the two
 * halves of a turn own opposite edges of the room and the eyes sit on the axis
 * between them. The rest are earlier sketches — `rings` and `halo` radiate from
 * behind the eyes, `pulse` lightens the whole field, `waveform` reuses the
 * listening band at whatever placement the room is already using.
 */
export type VoiceRespondingStyle =
  "waves" | "rings" | "halo" | "waveform" | "pulse";

/**
 * Smoothed output-amplitude → `--resp-amp` on a ref, for the responding
 * treatments to read in CSS. Imperative rAF (never React state), mirroring the
 * listening waveform's amplitude loop.
 */
function useRespondingAmp(getAmplitude?: () => number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const getRef = useRef(getAmplitude);
  const reduce = useReducedMotion();
  useEffect(() => {
    getRef.current = getAmplitude;
  }, [getAmplitude]);
  useEffect(() => {
    if (reduce) {
      return;
    }
    const node = ref.current;
    if (!node) {
      return;
    }
    const smoother = createAmplitudeSmoother({ attackMs: 90, releaseMs: 260 });
    let raf = 0;
    let lastTime = performance.now();
    let lastWritten = "";
    const tick = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;
      const get = getRef.current;
      const target = get ? Math.min(1, Math.max(0, get())) : 0;
      const v = smoother.step(target, dt).toFixed(3);
      if (v !== lastWritten) {
        lastWritten = v;
        node.style.setProperty("--resp-amp", v);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);
  return ref;
}

function VoiceRespondingTreatment({
  style,
  engine,
  getAmplitude,
  waveStyle,
  wavePlacement,
  wavePalette,
  viewport,
}: {
  style: VoiceRespondingStyle;
  engine: VoiceWaveEngine;
  getAmplitude?: () => number;
  waveStyle: VoiceWaveStyle;
  wavePlacement: VoiceWavePlacement;
  wavePalette: VoiceWavePalette;
  viewport: { w: number; h: number };
}) {
  const ampRef = useRespondingAmp(getAmplitude);
  const reduce = useReducedMotion();
  // Size against the room box (not `vh`/`vw`, which ignore the Storybook frame
  // and resolve against the window) so proportions match app and Storybook.
  const M = Math.min(viewport.w, viewport.h);

  if (style === "waves") {
    // The mirror of listening: the same band, the same engine, anchored to the
    // floor instead of the ceiling and fed the TTS output rather than the mic.
    // Nothing about it is a different visual language — that is the point. The
    // room says who is speaking by *where* the energy is, not by switching
    // metaphors mid-turn.
    return getAmplitude ? (
      <WaveBand
        engine={engine}
        getAmplitude={getAmplitude}
        waveStyle={waveStyle}
        palette={wavePalette}
        placement="bottom"
        color={BAND_VOICE.responding.color}
        peakOpacity={BAND_VOICE.responding.peakOpacity}
        opacityKnee={BAND_VOICE.responding.opacityKnee}
      />
    ) : null;
  }

  if (style === "waveform") {
    // The assistant's own voice — reuse the centered band, output-driven.
    return getAmplitude ? (
      <WaveBand
        engine={engine}
        getAmplitude={getAmplitude}
        waveStyle={waveStyle}
        palette="tone"
        placement={wavePlacement}
      />
    ) : null;
  }

  if (style === "pulse") {
    // The whole color field lightens gently on speech peaks.
    return (
      <div
        ref={ampRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundColor: "var(--room-fg, #ffffff)",
          opacity: "calc(var(--resp-amp, 0) * 0.14)",
        }}
      />
    );
  }

  if (style === "halo") {
    // A soft radial bloom behind the eyes, swelling + brightening with speech.
    return (
      <div
        ref={ampRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center"
      >
        <div
          // Tint (with iOS-15 rgba fallback) lives in `.voice-responding-halo`;
          // the amplitude-driven size/scale/opacity stay inline.
          className="voice-responding-halo"
          style={{
            width: Math.round(0.9 * M),
            height: Math.round(0.9 * M),
            borderRadius: "9999px",
            transform: "scale(calc(0.8 + var(--resp-amp, 0) * 0.5))",
            opacity: "calc(0.35 + var(--resp-amp, 0) * 0.65)",
            transformOrigin: "center",
          }}
        />
      </div>
    );
  }

  // `rings` — concentric rings expanding outward from the eyes; overall
  // presence scales with the TTS amplitude.
  return (
    <div
      ref={ampRef}
      aria-hidden="true"
      data-testid="voice-responding-rings"
      className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center"
      style={{ opacity: "calc(0.25 + var(--resp-amp, 0) * 0.75)" }}
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          // Border tint (with iOS-15 rgba fallback) lives in
          // `.voice-responding-ring`; the amplitude-driven size stays inline.
          className="voice-responding-ring absolute rounded-full border-2"
          style={{
            width: Math.round(0.5 * M),
            height: Math.round(0.5 * M),
          }}
          initial={reduce ? false : { scale: 0.4, opacity: 0.55 }}
          animate={
            reduce
              ? { opacity: 0.2 }
              : { scale: [0.4, 1.75], opacity: [0.55, 0] }
          }
          transition={
            reduce
              ? { duration: 0 }
              : {
                  duration: 2.4,
                  repeat: Infinity,
                  ease: "easeOut",
                  delay: i * 0.8,
                }
          }
        />
      ))}
    </div>
  );
}

/**
 * The `rings` responding treatment as a self-contained layer: the concentric
 * rings radiating outward from the room's center on the TTS-output amplitude.
 * Pass `viewport` to size against the room's own box (the room passes its
 * measured panel; Storybook its frame); omitted, it falls back to the live
 * window. Exported for the void look, which renders it behind the centered
 * avatar so a custom avatar emits the same rings the eyes do in the color look.
 */
export function VoiceRespondingRings({
  getAmplitude,
  viewport,
}: {
  /** TTS (output) amplitude source (0–1) — drives the rings' presence. */
  getAmplitude?: () => number;
  /** The room box to size against; omitted, falls back to the window. */
  viewport?: { w: number; h: number };
}) {
  const measured = useViewportSize();
  return (
    <VoiceRespondingTreatment
      style="rings"
      getAmplitude={getAmplitude}
      // engine/waveStyle/wavePlacement/wavePalette are only read by the band
      // styles (`waves`, `waveform`); inert for the rings.
      engine="reactive"
      waveStyle="fill"
      wavePlacement="top"
      wavePalette="tone"
      viewport={viewport ?? measured}
    />
  );
}

/**
 * Rest position + entrance geometry for the eyes, per placement. The eyes grow
 * from the entry origin (start offset by `origin − restCenter`, scaled down)
 * and settle at rest with a small dip.
 */
function eyeLayout(
  placement: VoiceEyePlacement,
  eyesW: number,
  eyesH: number,
  w: number,
  h: number,
  origin: { x: number; y: number },
): {
  restTop: number;
  startX: number;
  startY: number;
  dipY: number;
} {
  const bottomRestTop = h - (1 - EYE_REST_CUTOFF) * eyesH;
  const restTop = placement === "center" ? (h - eyesH) / 2 : bottomRestTop;
  // Rest center (the eyes are horizontally centered: left = (w − eyesW) / 2).
  const restCenterX = w / 2;
  const restCenterY = restTop + eyesH / 2;
  return {
    restTop,
    startX: origin.x - restCenterX,
    startY: origin.y - restCenterY,
    // A small settle dip below rest as they land.
    dipY: eyesH * 0.12,
  };
}

export function VoiceRoomEyes({
  art,
  viewport,
  placement = "center",
  entranceOrigin,
  entrance: requestedEntrance = "grow",
  sizeScale = 1,
  dimmed = false,
  eyeReaction = null,
  getAmplitude,
}: {
  art: VoiceRoomEyeArt;
  /** The room box the eyes are framed in (the caller's live viewport size). */
  viewport: { w: number; h: number };
  placement?: VoiceEyePlacement;
  /** Room-local point the eyes grow from on entrance. Defaults to room center.
   *  Unread when {@link entrance} is `"presented"`. */
  entranceOrigin?: { x: number; y: number };
  /** How the eyes arrive. See `voice-room-entrance.ts`. */
  entrance?: VoiceRoomEntrance;
  /**
   * Audio gesture the eyes express — `listening` widens them with the mic,
   * `responding` pulses them with the assistant's own voice, `null` holds them
   * still. See `use-reactive-eyes.ts`.
   */
  eyeReaction?: VoiceEyeReaction;
  /** Amplitude source (0–1) for {@link eyeReaction}, polled in a rAF loop. */
  getAmplitude?: () => number;
  /** Per-state size, as a scale of the rest geometry — tweened on change so the
   *  eyes resize smoothly (they never move). See {@link EYE_STATE_SCALE}. */
  sizeScale?: number;
  /** Fade the eyes back (the reconnecting state — presence dimmed while away). */
  dimmed?: boolean;
}) {
  const reduce = useReducedMotion();
  const { w, h } = viewport;
  const entrance = withReducedMotion(requestedEntrance, reduce === true);
  const playEntrance = entrance === "grow";
  const reactiveRef = useReactiveEyes(eyeReaction, getAmplitude);

  // The parallax offset and the blink are decorative, so both drive the DOM
  // through a ref rather than React state: a pointer-rate or frame-rate
  // updater in the commit stream is what walks React's nested-update counter
  // to its limit. See docs/CONVENTIONS.md, "Keep decorative animation out of
  // the commit stream". The rendered values below stay constant so a re-render
  // never clobbers the imperative write.
  const parallaxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (reduce) {
      return;
    }
    const onMove = (e: MouseEvent) => {
      const node = parallaxRef.current;
      if (!node) {
        return;
      }
      const x = (e.clientX / window.innerWidth - 0.5) * 2;
      const y = (e.clientY / window.innerHeight - 0.5) * 2;
      node.style.transform = `translate(${x * CURSOR_MAX_X}px, ${y * CURSOR_MAX_Y}px)`;
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [reduce]);

  // Two settle blinks once the entrance lands, then a slow random idle blink —
  // onboarding's entrance blink choreography.
  const eyelidsRef = useRef<SVGGElement | null>(null);
  const setBlink = useCallback((closed: boolean) => {
    const node = eyelidsRef.current;
    if (node) {
      node.style.transform = closed ? "scaleY(0.1)" : "scaleY(1)";
    }
  }, []);

  const [entranceDone, setEntranceDone] = useState(!playEntrance);
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
      setBlink(true);
      t = setTimeout(() => {
        if (cancelled) {
          return;
        }
        setBlink(false);
        t = setTimeout(next, 140);
      }, 140);
    };
    const idle = () => {
      t = setTimeout(() => blink(idle), 2500 + Math.random() * 4000);
    };
    blink(() => blink(idle));
    // Leaving the lids open on teardown keeps a torn-down or re-armed loop
    // from stranding the eyes mid-blink.
    return () => {
      cancelled = true;
      clearTimeout(t);
      setBlink(false);
    };
  }, [reduce, entranceDone, setBlink]);

  // Poke-the-eyes delight: clicking the eyes fires a single blink and a quick
  // springy wobble that settles back. The blink goes through the same
  // `setBlink` the idle loop uses (its own timeout is tracked so rapid clicks
  // don't leak), and the wobble rides a dedicated controls-driven layer so it
  // can't fight the entrance keyframes or the per-state scale tween. Reduced
  // motion keeps the discrete blink and skips the wobble.
  const wobble = useAnimationControls();
  const manualBlinkTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (manualBlinkTimeout.current) {
        clearTimeout(manualBlinkTimeout.current);
      }
    },
    [],
  );
  const reactToClick = useCallback(() => {
    setBlink(true);
    if (manualBlinkTimeout.current) {
      clearTimeout(manualBlinkTimeout.current);
    }
    manualBlinkTimeout.current = setTimeout(() => setBlink(false), 140);
    if (reduce) {
      return;
    }
    void wobble.start({
      scaleX: [1, 1.06, 0.96, 1],
      scaleY: [1, 0.92, 1.04, 1],
      rotate: [0, -2.5, 1.5, 0],
      transition: { duration: 0.5, ease: "easeOut" },
    });
  }, [reduce, wobble, setBlink]);

  const originX = entranceOrigin?.x ?? w / 2;
  const originY = entranceOrigin?.y ?? (ENTER_FROM_CENTER_VH / 100) * h;
  const geometry = useMemo(() => {
    const eyesH = eyeDisplayHeight(art, w, h);
    const eyesW = (eyesH * art.bbox.w) / art.bbox.h;
    const { restTop, startX, startY, dipY } = eyeLayout(
      placement,
      eyesW,
      eyesH,
      w,
      h,
      { x: originX, y: originY },
    );
    return {
      eyesW,
      eyesH,
      left: (w - eyesW) / 2,
      restTop,
      startX,
      startY,
      dipY,
    };
  }, [art, w, h, placement, originX, originY]);

  const cx = art.bbox.x + art.bbox.w / 2;
  const cy = art.bbox.y + art.bbox.h / 2;

  return (
    <motion.div
      aria-hidden="true"
      data-testid="voice-room-eyes"
      className="pointer-events-none absolute"
      style={{
        left: geometry.left,
        top: geometry.restTop,
        width: geometry.eyesW,
        height: geometry.eyesH,
        transformOrigin: "center",
      }}
      {...eyesEntranceMotion(entrance, geometry, entranceDone)}
      onAnimationComplete={() => setEntranceDone(true)}
    >
      {/* Per-state size: the eyes stay put and resize, on the same motion tween
          system as the entrance. `sizeScale` retargets `scale`; a mid-flight
          state change continues smoothly from wherever the eyes are. Reduced
          motion still targets `sizeScale` (size carries the state) — it just
          snaps there instantly rather than tweening. */}
      <motion.div
        style={{ transformOrigin: "center" }}
        animate={{ scale: sizeScale }}
        transition={
          reduce
            ? { duration: 0 }
            : { duration: EYE_RESIZE_MS / 1000, ease: "easeInOut" }
        }
      >
        {/* The opacity fades the eyes back while reconnecting. */}
        <div
          style={{
            opacity: dimmed ? 0.4 : 1,
            transition: "opacity 0.5s ease",
          }}
        >
          {/* Poke-the-eyes hit target + wobble layer. `pointer-events-auto`
              re-enables clicks (the outer wrapper is `pointer-events-none`);
              the wobble rides its own controls so it composes with — rather
              than fights — the per-state scale on the ancestor. Still
              `aria-hidden` on the wrapper: this is decorative delight, not a
              control. */}
          <motion.div
            className="pointer-events-auto cursor-pointer"
            style={{ transformOrigin: "center" }}
            animate={wobble}
            onClick={reactToClick}
          >
            {/* Slight parallax: the whole eyes drift smoothly toward the
                cursor — a few px only, so they stay visually centered on the
                room's spine (see CURSOR_MAX_X / CURSOR_MAX_Y). */}
            <div
              ref={parallaxRef}
              data-testid="voice-room-eyes-parallax"
              style={{
                transform: "translate(0px, 0px)",
                transition: "transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)",
              }}
            >
              {/* Audio reaction: its own layer so the per-frame amplitude
                  transform composes with the blink squish below and the size
                  tween above instead of overwriting either. */}
              <div
                ref={reactiveRef}
                className="voice-room-eyes-reactive"
                data-eye-reaction={eyeReaction ?? undefined}
              >
                <svg
                  viewBox={`${art.bbox.x} ${art.bbox.y} ${art.bbox.w} ${art.bbox.h}`}
                  width={geometry.eyesW}
                  height={geometry.eyesH}
                  style={{ overflow: "visible", display: "block" }}
                >
                  {/* Eyelids are driven imperatively (LUM-2927) — the blink
                      must not re-render this tree, and neither must the audio
                      reaction on the wrapper above it. */}
                  <g
                    ref={eyelidsRef}
                    style={{
                      transform: "scaleY(1)",
                      transformOrigin: `${cx}px ${cy}px`,
                      transition: "transform 0.14s ease-in-out",
                    }}
                  >
                    {art.paths.map((p, i) => (
                      <path key={i} d={p.svgPath} fill={p.color} />
                    ))}
                  </g>
                </svg>
              </div>
            </div>
          </motion.div>
        </div>
      </motion.div>
    </motion.div>
  );
}
