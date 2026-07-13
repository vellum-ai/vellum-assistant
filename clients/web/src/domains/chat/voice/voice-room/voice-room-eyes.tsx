/**
 * The color look for the voice room — the onboarding "avatar is the screen"
 * treatment reused for character avatars.
 *
 * `resolveVoiceRoomLook` maps the assistant's avatar data to the look; the
 * {@link VoiceRoomColorLook} component plays the onboarding Introduction
 * step's entrance on mount, so opening the room reads as the avatar growing
 * from "on the screen" to BEING the screen:
 *
 * 1. the room starts on a dark surface,
 * 2. the avatar's body shape springs from its small on-screen size up to
 *    cover the viewport end to end,
 * 3. the matching color layer fades in behind it (covering the body shape's
 *    gaps/spikes),
 * 4. the giant eyes rise from the center into their bottom-edge rest —
 *    dipping a touch below rest first — then settle with a double blink and
 *    idle-blink from there (with a slight cursor parallax).
 *
 * Geometry and timing mirror onboarding's `IntroductionScreen` +
 * `OnboardingPeekingEyes`. Traits default like `ChatAvatar` does (first
 * component of each type), so a default-character assistant gets the same
 * color and eyes the user sees in its small avatar. Custom-image /
 * no-character avatars resolve to `null` and the room falls back to its
 * ambient-void look — what that look should become is an open design
 * question.
 *
 * Decorative: `aria-hidden`, `pointer-events-none`, reduced-motion safe (no
 * entrance, no parallax; the blink is a discrete squish, kept). Sized against
 * the window — the room is a `fixed inset-0` overlay, so the window IS its
 * box.
 */

import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

import { pathBBox, unionBBox, type BBox } from "@/components/avatar/eye-bbox";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

/** How much of the eyes sits below the bottom edge — at rest, and at the dip. */
const EYE_REST_CUTOFF = 0.25;
const EYE_DIP_CUTOFF = 0.46;
/** Eye sizing: height at most 30% of the smaller viewport dimension, capped
 *  so width stays on-screen. */
const EYE_TARGET_HEIGHT = 0.3;
const EYE_MAX_WIDTH = 0.85;
/** Slight whole-eye cursor parallax. */
const CURSOR_MAX_X = 14;
const CURSOR_MAX_Y = 8;
/** The entrance grows the body from this "avatar on the screen" size and the
 *  eyes from this vertical center — onboarding's picker geometry. */
const ENTER_FROM_SIZE = 200;
const ENTER_FROM_CENTER_VH = 40;
/** The room's own dark base, under the color fade (matches the ambient look's
 *  deep surface so the first frames read the same for both looks). */
const DARK_SURFACE = "#17191C";

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
  if (!components) return null;
  // A custom uploaded image with no traits renders as the image avatar, not a
  // character — same precedence as ChatAvatar's `preferCharacter`.
  if (!traits && customImageUrl) return null;
  const effectiveTraits =
    traits ??
    (components.bodyShapes[0] && components.eyeStyles[0] && components.colors[0]
      ? {
          bodyShape: components.bodyShapes[0].id,
          eyeStyle: components.eyeStyles[0].id,
          color: components.colors[0].id,
        }
      : null);
  if (!effectiveTraits) return null;
  const eyeDef = components.eyeStyles.find(
    (e) => e.id === effectiveTraits.eyeStyle,
  );
  const bgHex = components.colors.find(
    (c) => c.id === effectiveTraits.color,
  )?.hex;
  if (!eyeDef || eyeDef.paths.length === 0 || !bgHex) return null;
  const bbox = unionBBox(eyeDef.paths.map((p) => pathBBox(p.svgPath)));
  // Degenerate art (empty paths) would make the sizing math divide by zero.
  if (bbox.w <= 0 || bbox.h <= 0) return null;
  const bodyDef = components.bodyShapes.find(
    (b) => b.id === effectiveTraits.bodyShape,
  );
  const body =
    bodyDef && bodyDef.viewBox.width > 0 && bodyDef.viewBox.height > 0
      ? { svgPath: bodyDef.svgPath, viewBox: bodyDef.viewBox }
      : null;
  return { bgHex, art: { paths: eyeDef.paths, bbox }, body };
}

function windowSize(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}

/** The window box, kept live on resize — the room is a full-viewport overlay. */
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
 * peeking eyes. Mount = session start (the room only mounts once per
 * session), so mounting plays the entrance.
 */
export function VoiceRoomColorLook({ look }: { look: VoiceRoomLook }) {
  const reduce = useReducedMotion();
  const { w, h } = useViewportSize();

  // Body grows to cover the screen end to end, from the small avatar size —
  // onboarding's Introduction grow, verbatim.
  const bodyGeometry = useMemo(() => {
    if (!look.body) return null;
    const coverSize = 1.25 * Math.max(w, h);
    const coverH = (coverSize * look.body.viewBox.height) / look.body.viewBox.width;
    return {
      coverSize,
      coverH,
      left: (w - coverSize) / 2,
      top: (h - coverH) / 2,
      startScale: ENTER_FROM_SIZE / coverSize,
      startY: (ENTER_FROM_CENTER_VH / 100 - 0.5) * h,
    };
  }, [look.body, w, h]);

  return (
    <>
      {/* Dark base, so the grow has something to happen over. */}
      <div
        className="absolute inset-0"
        style={{ backgroundColor: DARK_SURFACE }}
      />

      {/* The avatar color fills in behind the body so coverage is end-to-end
          even where the body shape has gaps/spikes. */}
      <motion.div
        className="absolute inset-0"
        style={{ backgroundColor: look.bgHex }}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reduce ? { duration: 0 } : { duration: 0.6, delay: 0.35 }}
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
          initial={
            reduce
              ? false
              : { scale: bodyGeometry.startScale, y: bodyGeometry.startY }
          }
          animate={{ scale: 1, y: 0 }}
          transition={
            reduce
              ? { duration: 0 }
              : { type: "spring", stiffness: 78, damping: 18, mass: 1 }
          }
        >
          <path d={look.body.svgPath} fill={look.bgHex} />
        </motion.svg>
      ) : null}

      <VoiceRoomEyes art={look.art} viewport={{ w, h }} />
    </>
  );
}

export function VoiceRoomEyes({
  art,
  viewport,
}: {
  art: VoiceRoomEyeArt;
  /** The room box the eyes are framed in (the caller's live viewport size). */
  viewport: { w: number; h: number };
}) {
  const reduce = useReducedMotion();
  const { w, h } = viewport;
  const playEntrance = !reduce;

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

  // Two settle blinks once the entrance lands, then a slow random idle blink —
  // onboarding's entrance blink choreography.
  const [blinking, setBlinking] = useState(false);
  const [entranceDone, setEntranceDone] = useState(!playEntrance);
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
    blink(() => blink(idle));
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [reduce, entranceDone]);

  const geometry = useMemo(() => {
    const maxEyesW = w * EYE_MAX_WIDTH;
    const eyesH = Math.min(
      Math.min(w, h) * EYE_TARGET_HEIGHT,
      (maxEyesW * art.bbox.h) / art.bbox.w,
    );
    const eyesW = (eyesH * art.bbox.w) / art.bbox.h;
    const restTop = h - (1 - EYE_REST_CUTOFF) * eyesH;
    return {
      eyesW,
      eyesH,
      left: (w - eyesW) / 2,
      restTop,
      // Entrance: rise from the "avatar on the screen" center, dip a touch
      // below rest, settle.
      startY: (ENTER_FROM_CENTER_VH / 100) * h - (restTop + eyesH / 2),
      dipY: (EYE_DIP_CUTOFF - EYE_REST_CUTOFF) * eyesH,
    };
  }, [art, w, h]);

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
      initial={playEntrance ? { y: geometry.startY, scale: 0.35 } : false}
      animate={
        playEntrance
          ? { y: [geometry.startY, geometry.dipY, 0], scale: [0.35, 1, 1] }
          : { y: 0, scale: 1 }
      }
      transition={
        playEntrance
          ? { duration: 1, times: [0, 0.7, 1], ease: "easeInOut" }
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
          viewBox={`${art.bbox.x} ${art.bbox.y} ${art.bbox.w} ${art.bbox.h}`}
          width={geometry.eyesW}
          height={geometry.eyesH}
          style={{ overflow: "visible", display: "block" }}
        >
          <g
            style={{
              transform: blinking ? "scaleY(0.1)" : "scaleY(1)",
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
    </motion.div>
  );
}
