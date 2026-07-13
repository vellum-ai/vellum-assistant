/**
 * The session assistant's eyes peeking up from the bottom of the voice room —
 * the onboarding "full-screen color with eyes" treatment reused as the room's
 * look for character avatars.
 *
 * `resolveVoiceRoomLook` maps the assistant's avatar data to the look: the
 * avatar color fills the room and the avatar's eye style renders giant at the
 * bottom edge, ~25% cut off, with an idle blink and a slight cursor parallax
 * (geometry and behavior mirror onboarding's `OnboardingPeekingEyes`). Traits
 * default like `ChatAvatar` does (first component of each type), so a
 * default-character assistant gets the same color and eyes the user sees in
 * its small avatar. Custom-image / no-character avatars resolve to `null` and
 * the room falls back to its ambient-void look — what that look should become
 * is an open design question.
 *
 * Decorative: `aria-hidden`, `pointer-events-none`, reduced-motion safe (no
 * parallax; the blink is a discrete squish, kept). Sized against the window —
 * the room is a `fixed inset-0` overlay, so the window IS its box.
 */

import { useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "motion/react";

import { pathBBox, unionBBox, type BBox } from "@/components/avatar/eye-bbox";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

/** How much of the eyes sits below the bottom edge. */
const EYE_REST_CUTOFF = 0.25;
/** Eye sizing: height at most 30% of the smaller viewport dimension, capped
 *  so width stays on-screen. */
const EYE_TARGET_HEIGHT = 0.3;
const EYE_MAX_WIDTH = 0.85;
/** Slight whole-eye cursor parallax. */
const CURSOR_MAX_X = 14;
const CURSOR_MAX_Y = 8;

export interface VoiceRoomEyeArt {
  paths: { svgPath: string; color: string }[];
  bbox: BBox;
}

export interface VoiceRoomLook {
  /** The avatar color that fills the room. */
  bgHex: string;
  /** The avatar's eye art, sized/framed by its union bounding box. */
  art: VoiceRoomEyeArt;
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
    (components.eyeStyles[0] && components.colors[0]
      ? { eyeStyle: components.eyeStyles[0].id, color: components.colors[0].id }
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
  return { bgHex, art: { paths: eyeDef.paths, bbox } };
}

function windowSize(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}

export function VoiceRoomEyes({ art }: { art: VoiceRoomEyeArt }) {
  const reduce = useReducedMotion();
  const [{ w, h }, setSize] = useState(windowSize);

  useEffect(() => {
    const onResize = () => setSize(windowSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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

  // Slow random idle blink (a 140ms squish), like the onboarding eyes at rest.
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout>;
    const idle = () => {
      t = setTimeout(() => {
        if (cancelled) return;
        setBlinking(true);
        t = setTimeout(() => {
          if (cancelled) return;
          setBlinking(false);
          idle();
        }, 140);
      }, 2500 + Math.random() * 4000);
    };
    idle();
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [reduce]);

  const geometry = useMemo(() => {
    const maxEyesW = w * EYE_MAX_WIDTH;
    const eyesH = Math.min(
      Math.min(w, h) * EYE_TARGET_HEIGHT,
      (maxEyesW * art.bbox.h) / art.bbox.w,
    );
    const eyesW = (eyesH * art.bbox.w) / art.bbox.h;
    return {
      eyesW,
      eyesH,
      left: (w - eyesW) / 2,
      top: h - (1 - EYE_REST_CUTOFF) * eyesH,
    };
  }, [art, w, h]);

  const cx = art.bbox.x + art.bbox.w / 2;
  const cy = art.bbox.y + art.bbox.h / 2;

  return (
    <div
      aria-hidden="true"
      data-testid="voice-room-eyes"
      className="pointer-events-none absolute z-0"
      style={{
        left: geometry.left,
        top: geometry.top,
        width: geometry.eyesW,
        height: geometry.eyesH,
      }}
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
    </div>
  );
}
