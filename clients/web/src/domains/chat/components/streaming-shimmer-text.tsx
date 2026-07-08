import { GradientShimmer, type GradientStop } from "gradient-shimmer";
import { useMemo } from "react";

/**
 * Gradient band for a given accent color: the saturated accent at the core
 * with soft, white-lightened edges so the sweep reads as a playful glint
 * rather than a solid recolor. `color-mix` keeps the derivation in CSS — no
 * hex math — and accepts both raw hex values and `var()` expressions.
 */
export function shimmerStopsForAccent(accent: string): GradientStop[] {
  const edge = `color-mix(in srgb, ${accent} 40%, white)`;
  return [
    { position: 0, color: edge },
    { position: 0.5, color: accent },
    { position: 1, color: edge },
  ];
}

/**
 * The assistant's avatar accent published on `<html>` by
 * `useAvatarAccentVar`, falling back to the theme's emphasised content color
 * when no character avatar is active (custom-image avatars, avatar still
 * loading, storybook) — the sweep stays a neutral brighten instead of an
 * arbitrary hue.
 */
const AVATAR_ACCENT = "var(--avatar-accent, var(--content-emphasised))";

export interface StreamingShimmerTextProps {
  /** The label to shimmer. Plain string — the gradient sweeps over real text. */
  children: string;
  /**
   * Explicit accent color override (hex). When omitted, the sweep tints to
   * the active assistant's avatar color via the `--avatar-accent` custom
   * property.
   */
  colorHex?: string;
  className?: string;
  "data-testid"?: string;
}

/**
 * The chat streaming-state text treatment: a gentle gradient glint, tinted to
 * the assistant's avatar color, sweeping across the loading label. Replaces
 * the three-dot pulse for transcript loading affordances — the label itself
 * carries the "working on it" signal.
 *
 * Motion niceties come from `gradient-shimmer`: the sweep pauses off-screen
 * and while scrolling, and renders a static gradient under
 * `prefers-reduced-motion`.
 */
export function StreamingShimmerText({
  children,
  colorHex,
  className,
  "data-testid": dataTestId,
}: StreamingShimmerTextProps) {
  const accent = colorHex ?? AVATAR_ACCENT;
  const gradient = useMemo(() => shimmerStopsForAccent(accent), [accent]);
  return (
    <GradientShimmer
      gradient={gradient}
      easing="gentle"
      duration={1}
      spread={6}
      angle={106}
      pauseBetween={0}
      className={className}
      data-testid={dataTestId}
    >
      {children}
    </GradientShimmer>
  );
}
