/**
 * Animated character stage for the "Give me a face and a name" picker step.
 *
 * SPIKE — research-onboarding flow.
 *
 * Owns all 10 pool characters in one fixed coordinate layer: 9 sit at edge
 * slots (cut off by the viewport) and 1 is the selected avatar in the center.
 * Sizes scale with the viewport so the cast reads big on desktop and still fits
 * on mobile.
 *
 * On selection nothing slides across the middle — it feels like the characters
 * step backstage and reappear:
 *   - the newly selected character flies off-screen out of its edge slot, then
 *     pops into the center with a tiny bounce;
 *   - the previously-centered character shrinks away at the center, then fades
 *     back in at the slot the new one vacated.
 *
 * Decorative layer: `aria-hidden`, `pointer-events-none` (the arrows + inputs
 * that drive it live in the screen above). Reduced-motion safe.
 */

import { useMemo } from "react";
import { motion, useReducedMotion, type Easing } from "motion/react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { useOnboardingStageSize } from "@/domains/onboarding/hooks/use-onboarding-stage-size";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

/** Where the centered avatar sits, as viewport fractions. */
const CENTER_POINT = { x: 0.5, y: 0.4 };

/**
 * Slight per-slot tilt (degrees) so the edge cast isn't all bolt-upright. Some
 * are left at 0. Indexed by edge slot; the centered avatar is always upright.
 */
export const SLOT_ROTATIONS = [-8, 6, 9, 0, 7, -6, 5, 0, -7, 4, -5, 6];
function slotRotation(slot: number): number {
  return SLOT_ROTATIONS[slot % SLOT_ROTATIONS.length] ?? 0;
}

/**
 * Two-plane depth per edge slot — 0 = background, 1 = foreground — shared by both
 * onboarding screens (the first-screen scatter and this picker) so the cast
 * layers identically. The one value drives stacking (z-index), opacity, and
 * size together: background avatars are dimmed, shrunk, and sit behind; the
 * foreground stays full opacity and on top. No in-between opacities. Slots past
 * the table default to foreground. The centered (selected) avatar always renders
 * above every edge.
 */
const SLOT_DEPTH = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0];
const DEPTH_SCALE = [0.72, 1];
const DEPTH_OPACITY = [0.4, 1];
const DEPTH_Z = [10, 20];
/** z-index for the centered avatar — above every edge plane. */
const CENTER_Z = 50;

export function slotDepthScale(slot: number): number {
  return DEPTH_SCALE[SLOT_DEPTH[slot] ?? 1] ?? 1;
}
export function slotDepthOpacity(slot: number): number {
  return DEPTH_OPACITY[SLOT_DEPTH[slot] ?? 1] ?? 1;
}
export function slotDepthZ(slot: number): number {
  return DEPTH_Z[SLOT_DEPTH[slot] ?? 1] ?? 20;
}

/**
 * Edge avatars render at this (large) px box; the center avatar is shown
 * smaller (scaled down) so it sits between the arrows. Both scale with the
 * viewport so the cast is big on desktop and fits on mobile.
 */
export function edgeSize(w: number, h: number): number {
  // Scales with the smaller viewport dimension so it shrinks on mobile; the low
  // floor keeps it from being oversized on narrow phones.
  return Math.round(Math.max(130, Math.min(Math.min(w, h) * 0.4, 420)));
}
function centerSize(w: number, h: number): number {
  // Kept under the arrow gap (arrows sit at 50% ± 170px) so it fits between.
  return Math.round(Math.max(110, Math.min(Math.min(w, h) * 0.21, 205)));
}

/**
 * The 9 edge slots as px center points around the perimeter. Order is stable so
 * a given slot keeps its place as characters swap through it. The top and
 * bottom slots are offset off-center so nothing sits behind the centered
 * progress header or the Continue button. Each slot's center sits well inside
 * the edge avatar's radius from the screen edge, so most of the avatar is cut
 * off — only the inner (eye-bearing) part shows.
 */
export function edgeSlots(w: number, h: number, edgeRadius: number): { x: number; y: number }[] {
  const side = edgeRadius * 0.4; // ~60% of the avatar clipped off-screen
  const corner = edgeRadius * 0.48;
  // Order matches HARDCODED_POOL indices 1–11 (see onboarding-avatar-pool-store).
  return [
    { x: corner, y: corner }, // 0 top-left corner → purple blob
    { x: w * 0.3, y: side }, // 1 top, left of center → orange star
    { x: w * 0.72, y: side }, // 2 top, right of center → pink blob
    { x: w - corner, y: corner }, // 3 top-right corner → yellow ninja
    { x: w - side, y: h * 0.72 }, // 4 right lower → pink urchin
    { x: w - corner, y: h - corner }, // 5 bottom-right corner → orange burst
    { x: corner, y: h - corner }, // 6 bottom-left corner → green ghost
    { x: side, y: h * 0.5 }, // 7 left mid → orange sprout
    { x: w - side, y: h * 0.3 }, // 8 right upper → teal star
    { x: w * 0.38, y: h - side }, // 9 bottom, left of center → pink flower
    { x: w * 0.62, y: h - side }, // 10 bottom, right of center → yellow cloud
  ];
}

/** A point pushed well off-screen along the ray from center through `from`. */
function offscreenPoint(
  from: { x: number; y: number },
  cx: number,
  cy: number,
  w: number,
  h: number,
): { x: number; y: number } {
  const dx = from.x - cx;
  const dy = from.y - cy;
  const len = Math.hypot(dx, dy) || 1;
  const push = Math.max(w, h);
  return { x: from.x + (dx / len) * push, y: from.y + (dy / len) * push };
}

export interface OnboardingCharacterStageProps {
  components: CharacterComponents;
  characters: CharacterTraits[];
  /** Index of the character shown in the center. */
  centerChar: number;
  /** Char index occupying each of the 9 edge slots, in slot order. */
  edgeOrder: number[];
  /**
   * The newly selected character + the edge slot it came from — it flies off
   * screen, then pops into the center. Null on first render.
   */
  entering: { char: number; fromSlot: number } | null;
  /**
   * The previously-centered character + the edge slot it's heading to — it
   * shrinks away at the center, then reappears at that slot. Null on first
   * render.
   */
  exiting: { char: number; toSlot: number } | null;
  /** Fired with the entering char index when its animation finishes. */
  onEnterComplete: (char: number) => void;
  /** Fired when an edge character is clicked — selects it into the center. */
  onSelectChar: (char: number) => void;
}

export function OnboardingCharacterStage({
  components,
  characters,
  centerChar,
  edgeOrder,
  entering,
  exiting,
  onEnterComplete,
  onSelectChar,
}: OnboardingCharacterStageProps) {
  const { w, h } = useOnboardingStageSize();
  const reduce = useReducedMotion();

  // On narrow screens the side avatars sit behind the title/fields and feel
  // crowded, so the edge cast is kept to the top (slots 0–3) and bottom corners
  // (5, 6). Dropped on mobile: the side slots 4 (right-lower), 7 (left-mid), 8
  // (right-upper), plus the two bottom-center slots 9/10 (desktop-only, else the
  // bottom re-crowds). Those characters stay reachable via the arrows.
  const isMobile = w < 640;
  const MOBILE_HIDDEN_SLOTS = new Set([4, 7, 8, 9, 10]);
  const slotHidden = (slot: number) => isMobile && MOBILE_HIDDEN_SLOTS.has(slot);

  // Every avatar renders in the large edge box; the center one is scaled down.
  const size = edgeSize(w, h);
  const half = size / 2;
  const edgeRadius = size / 2;
  const centerScaleVal = centerSize(w, h) / size;
  const centerPx = centerSize(w, h);

  const slotOfChar = useMemo(() => {
    const map = new Map<number, number>();
    edgeOrder.forEach((charIndex, slot) => map.set(charIndex, slot));
    return map;
  }, [edgeOrder]);

  const centerX = CENTER_POINT.x * w;
  const centerY = CENTER_POINT.y * h;
  const centerTx = centerX - half;
  const centerTy = centerY - half;
  const slots = useMemo(() => edgeSlots(w, h, edgeRadius), [w, h, edgeRadius]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      {/* Soft contact shadow under the centered avatar. */}
      <div
        className="absolute rounded-[50%] bg-[var(--aux-black,#000)] opacity-20 blur-md"
        style={{
          width: centerPx * 0.62,
          height: 16,
          left: centerX - centerPx * 0.31,
          top: centerY + centerPx * 0.4,
        }}
      />

      {characters.map((traits, i) => {
        const isCenter = i === centerChar;
        const isEntering = !reduce && entering?.char === i;
        const isExiting = !reduce && exiting?.char === i;

        // Newly selected: fly off-screen out of its old slot, go invisible,
        // then pop into the center with a tiny bounce. No visible cross-screen
        // slide (it's transparent while it teleports back to center).
        if (isEntering) {
          const from = slots[entering.fromSlot]!;
          const off = offscreenPoint(from, centerX, centerY, w, h);
          // Start at the source slot's depth (it may be a dim/shrunk background
          // slot), then resolve to the full-size, full-opacity centre.
          const fromScale = slotDepthScale(entering.fromSlot);
          const fromOpacity = slotDepthOpacity(entering.fromSlot);
          return (
            <motion.div
              key={i}
              className="absolute left-0 top-0"
              style={{ width: size, height: size, zIndex: CENTER_Z }}
              initial={false}
              animate={{
                x: [from.x - half, off.x - half, off.x - half, centerTx, centerTx, centerTx],
                y: [from.y - half, off.y - half, off.y - half, centerTy, centerTy, centerTy],
                scale: [fromScale, fromScale, fromScale, centerScaleVal * 0.7, centerScaleVal * 1.08, centerScaleVal],
                opacity: [fromOpacity, fromOpacity, 0, 0, 1, 1],
              }}
              transition={{
                duration: 0.85,
                times: [0, 0.28, 0.34, 0.42, 0.72, 1],
                ease: ["easeIn", "linear", "linear", "easeOut", "easeOut"] as Easing[],
              }}
              onAnimationComplete={() => onEnterComplete(i)}
            >
              {/* Ends upright in the center. */}
              <AnimatedAvatar components={components} traits={traits} size={size} />
            </motion.div>
          );
        }

        // Previously centered — the exact opposite of the entering move: it
        // shrinks + fades away at the center, teleports off-screen (invisible),
        // then flies in from the edge and bounces into its slot. If that slot is
        // hidden on mobile, skip it so it doesn't land in a dropped side slot.
        if (isExiting) {
          if (slotHidden(exiting.toSlot)) return null;
          const to = slots[exiting.toSlot]!;
          const off = offscreenPoint(to, centerX, centerY, w, h);
          // Settle into the destination slot's depth (dim/shrunk if it's a
          // background slot) rather than always full size + opacity.
          const toScale = slotDepthScale(exiting.toSlot);
          const toOpacity = slotDepthOpacity(exiting.toSlot);
          return (
            <motion.div
              key={i}
              className="absolute left-0 top-0"
              style={{ width: size, height: size, zIndex: slotDepthZ(exiting.toSlot) }}
              initial={false}
              animate={{
                x: [centerTx, centerTx, off.x - half, off.x - half, to.x - half, to.x - half],
                y: [centerTy, centerTy, off.y - half, off.y - half, to.y - half, to.y - half],
                scale: [centerScaleVal, centerScaleVal * 0.6, toScale, toScale, toScale * 1.1, toScale],
                opacity: [1, 0, 0, toOpacity, toOpacity, toOpacity],
              }}
              transition={{
                duration: 0.85,
                times: [0, 0.28, 0.34, 0.45, 0.78, 1],
                ease: ["easeIn", "linear", "linear", "easeOut", "easeOut"] as Easing[],
              }}
            >
              {/* Lands tilted in its destination slot. */}
              <div style={{ transform: `rotate(${slotRotation(exiting.toSlot)}deg)` }}>
                <AnimatedAvatar
                  components={components}
                  traits={traits}
                  size={size}
                  breathe={false}
                />
              </div>
            </motion.div>
          );
        }

        const charSlot = slotOfChar.get(i) ?? 0;
        // Drop the side-slot characters on mobile (they're not the center).
        if (!isCenter && slotHidden(charSlot)) return null;
        const point = isCenter
          ? { x: centerX, y: centerY }
          : slots[charSlot]!;
        return (
          <motion.div
            key={i}
            // Edge avatars are clickable to select; the center one isn't.
            className={`absolute left-0 top-0 ${isCenter ? "" : "pointer-events-auto cursor-pointer"}`}
            style={{
              width: size,
              height: size,
              zIndex: isCenter ? CENTER_Z : slotDepthZ(charSlot),
            }}
            initial={false}
            animate={{
              x: point.x - half,
              y: point.y - half,
              // Background slots sit smaller, dimmer, and behind (see slot depth).
              scale: isCenter ? centerScaleVal : slotDepthScale(charSlot),
              opacity: isCenter ? 1 : slotDepthOpacity(charSlot),
            }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 230, damping: 26 }
            }
            onClick={isCenter ? undefined : () => onSelectChar(i)}
          >
            {/* Edge avatars sit slightly tilted; the center one stays upright.
                Only the centered (selected) avatar breathes — the scattered
                edge characters stay still. */}
            <div
              style={{
                transform: isCenter
                  ? undefined
                  : `rotate(${slotRotation(slotOfChar.get(i) ?? 0)}deg)`,
              }}
            >
              <AnimatedAvatar
                components={components}
                traits={traits}
                size={size}
                breathe={isCenter}
              />
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
