/**
 * The loading glint, swept across a whole SURFACE rather than clipped to text.
 *
 * {@link StreamingShimmerText} paints the same band through
 * `background-clip: text`, which needs a label to clip to. These triggers are
 * icons and avatars with no text at all, so the sweep has to travel across the
 * button itself. Same gradient builder, same angle, same phase lock, so the two
 * treatments read as one family rather than two lookalike animations.
 *
 * The one thing it does NOT share is the duration: see
 * {@link SURFACE_SWEEP_DURATION_MS} for why a pill needs a slower cycle than a
 * phrase does.
 *
 * Renders an inert overlay: absolutely positioned, `pointer-events-none`, and
 * `aria-hidden`, so it decorates the trigger without joining it. The host must
 * be a positioned, clipping box (`relative overflow-hidden`) or the band will
 * escape the pill's rounded edge.
 *
 * Honors `prefers-reduced-motion` by holding a static band instead of sweeping.
 */

import { useReducedMotion } from "motion/react";
import { useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";

import {
  AVATAR_ACCENT,
  buildBandGradient,
  shimmerStopsForAccent,
  SPREAD_MID_RATIO,
  SWEEP_ANGLE,
} from "@/domains/chat/components/streaming-shimmer-text";

/**
 * Slower than the text shimmer's own sweep, deliberately.
 *
 * The text version travels the width of a phrase, so a 1.5s cycle reads as a
 * gentle glint. The same cycle across a 36px pill is the band crossing a tiny
 * box every second and a half, which reads as flicker rather than shimmer. A
 * longer cycle over a short distance restores the original pace.
 *
 * Its own constant rather than the text one, so the two surfaces here stay in
 * step with each other without pinning the text treatment to the same number.
 */
const SURFACE_SWEEP_DURATION_MS = 3200;

/**
 * Band geometry in fixed pixels, NOT scaled to the host.
 *
 * This is what lets two pills of different widths read as one effect. The sweep
 * advances exactly one tile per iteration over a fixed duration, so a tile
 * sized to the element would give a narrow pill and a wide one different band
 * sizes AND different sweep speeds: phase-locked but visibly out of step. A
 * constant tile gives every surface the same glint travelling at the same rate;
 * a wider pill simply fits more repeats of it.
 *
 * The value is bounded from below by the SMALLEST host. An icon-only control is
 * one side-menu tile wide (36px), so it only ever samples a `36 / TILE_WIDTH_PX`
 * slice of the band at a time: too wide a tile and that slice is nearly always
 * the transparent base, leaving a pill that never visibly shimmers. Keeping the
 * tile within a few multiples of the smallest pill is what makes the glint
 * actually cross it once per cycle.
 */
const TILE_WIDTH_PX = 96;

/**
 * Half-width of the band itself. Independent of the tile, and deliberately well
 * under half of it: the gradient runs transparent → accent → transparent across
 * `±SPREAD_PX` from the tile's centre, so anything the band does not cover is
 * clear. At half the tile the band filled the whole period and the pill wore a
 * translucent wash permanently, with the glyph under it the entire time. A
 * tighter band leaves real gaps, so the content sits in the clear and a
 * distinct glint travels across it.
 */
const SPREAD_PX = 22;

/**
 * How strongly the glint reads over the trigger's own fill. The band is the
 * assistant's accent at full saturation; undimmed it recolors the pill instead
 * of passing over it. Kept low enough that the glyph underneath stays legible
 * as the band crosses it. The sweep is a highlight passing over the content,
 * not a tint sitting on top of it.
 */
const SURFACE_OPACITY = 0.34;

export function ShimmerSurface({
  /** Accent to tint the band. Defaults to the assistant's avatar accent. */
  colorHex,
  className,
}: {
  colorHex?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduceMotion = useReducedMotion();
  const accent = colorHex ?? AVATAR_ACCENT;
  const backgroundImage = useMemo(
    () => buildBandGradient(shimmerStopsForAccent(accent), SWEEP_ANGLE),
    [accent],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || reduceMotion || typeof el.animate !== "function") {
      return;
    }
    // Nothing to measure: the tile is a constant, so the sweep is identical on
    // every host and needs no ResizeObserver to stay correct as one resizes.
    const anim = el.animate(
      [
        { backgroundPosition: "0px center" },
        { backgroundPosition: `${TILE_WIDTH_PX}px center` },
      ],
      {
        duration: SURFACE_SWEEP_DURATION_MS,
        easing: "linear",
        iterations: Infinity,
      },
    );
    // Phase-locked to the document timeline's origin, so every shimmering
    // surface on screen moves together and a remount resumes mid-cycle.
    anim.startTime = 0;
    return () => anim.cancel();
  }, [reduceMotion]);

  const style = {
    backgroundImage,
    backgroundRepeat: "repeat-x",
    backgroundSize: `${TILE_WIDTH_PX}px 100%`,
    opacity: SURFACE_OPACITY,
    // Transparent base: the band is a layer OVER the trigger's own fill, so
    // everything outside it must let that fill through.
    "--gs-base": "transparent",
    "--gs-spread": `${SPREAD_PX}px`,
    "--gs-spread-mid": `${SPREAD_PX * SPREAD_MID_RATIO}px`,
  } as CSSProperties;

  return (
    <span
      ref={ref}
      aria-hidden
      data-testid="shimmer-surface"
      className={`pointer-events-none absolute inset-0 ${className ?? ""}`}
      style={style}
    />
  );
}
