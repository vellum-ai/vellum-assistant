import {
  buildBandGradient,
  easingPresets,
  type GradientStop,
} from "gradient-shimmer";
import { useReducedMotion } from "motion/react";
import { useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";

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

/**
 * The sweep is only perceivable as the contrast between band and base — with
 * the base at full `currentColor`, a light label (e.g. the active chip's
 * near-white text) meets a near-white band and the shimmer vanishes entirely.
 * Dimming the base guarantees the band reads as a bright glint in every tone
 * and theme.
 */
const BASE_COLOR = "color-mix(in srgb, currentColor 45%, transparent)";

// Sweep timing/geometry. Shared constants (not props) on purpose: every
// instance having identical duration + easing is what lets the shared-clock
// phase lock below hold across instances.
const SWEEP_DURATION_MS = 1500;
const SWEEP_ANGLE = 106;
const SPREAD_PER_CHAR_PX = 6;
const MAX_SPREAD_PX = 48;
/** Must match the `--gs-spread-mid` derivation `buildBandGradient` expects. */
const SPREAD_MID_RATIO = 0.72;
const BASE_FONT_PX = 14;
const FALLBACK_TEXT_WIDTH_PX = 96;

/** With clip unsupported the transparent text-fill would hide the label. */
function supportsBackgroundClipText(): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    return false;
  }
  return (
    CSS.supports("background-clip", "text") ||
    CSS.supports("-webkit-background-clip", "text")
  );
}

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
 * the assistant's avatar color, sweeping across the loading label.
 *
 * The sweep is built for continuity — the "working on it" signal must never
 * visibly reset while a turn is in flight. Every instance runs an infinite
 * Web Animations API sweep with `startTime = 0`, phase-locking it to the
 * document timeline's origin. Because the phase is a pure function of the
 * shared clock, any re-creation of the animation — a label swap from the
 * daemon's activity status, a remount, or a handoff between the shimmer's
 * hosts (the standalone thinking row, the inline thinking link, the
 * tool-card header) — resumes the sweep mid-cycle instead of snapping it
 * back to the start. The band parks just off-text at both ends of a cycle,
 * so the iteration wrap is invisible too.
 *
 * Renders a static gradient under `prefers-reduced-motion`, and plain text
 * when `background-clip: text` is unsupported.
 */
export function StreamingShimmerText({
  children,
  colorHex,
  className,
  "data-testid": dataTestId,
}: StreamingShimmerTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduceMotion = useReducedMotion();
  const accent = colorHex ?? AVATAR_ACCENT;
  const backgroundImage = useMemo(
    () => buildBandGradient(shimmerStopsForAccent(accent), SWEEP_ANGLE),
    [accent],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    if (!supportsBackgroundClipText()) {
      el.style.removeProperty("background-image");
      el.style.removeProperty("-webkit-text-fill-color");
      return;
    }
    if (reduceMotion || typeof el.animate !== "function") {
      return;
    }

    let anim: Animation | null = null;
    // Measure the label and start the sweep. Runs pre-paint (layout effect /
    // resize-observer callback), so the cancel + re-create below never shows
    // an intermediate frame — and the phase lock lands the new animation at
    // the exact position the old one occupied.
    const startSweep = () => {
      const textWidth =
        el.getBoundingClientRect().width || FALLBACK_TEXT_WIDTH_PX;
      const fontSize =
        Number.parseFloat(getComputedStyle(el).fontSize) || BASE_FONT_PX;
      const fontScale = fontSize / BASE_FONT_PX;
      const spreadPx = Math.min(
        children.length * SPREAD_PER_CHAR_PX * fontScale,
        MAX_SPREAD_PX * fontScale,
      );
      const layerWidth = Math.max(1, textWidth + spreadPx * 2);
      el.style.setProperty("--gs-spread", `${spreadPx}px`);
      el.style.setProperty(
        "--gs-spread-mid",
        `${spreadPx * SPREAD_MID_RATIO}px`,
      );
      el.style.backgroundSize = `${layerWidth}px 100%`;
      anim?.cancel();
      anim = el.animate(
        [
          { backgroundPosition: `${-spreadPx - layerWidth / 2}px center` },
          {
            backgroundPosition: `${textWidth + spreadPx - layerWidth / 2}px center`,
          },
        ],
        {
          duration: SWEEP_DURATION_MS,
          easing: easingPresets.smooth,
          iterations: Infinity,
        },
      );
      anim.startTime = 0;
    };

    startSweep();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(startSweep);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      anim?.cancel();
    };
  }, [children, reduceMotion]);

  // Character-count-derived spread so the pre-measure paint (and the static
  // reduced-motion rendering) shows a plausible band; `startSweep` replaces
  // these with measured values before the first animated frame.
  const initialSpread = Math.min(
    children.length * SPREAD_PER_CHAR_PX,
    MAX_SPREAD_PX,
  );
  const style = {
    position: "relative",
    display: "inline-block",
    backgroundImage,
    backgroundRepeat: "no-repeat",
    backgroundSize: "100% 100%",
    // Text outside the gradient layer still renders in the base color.
    backgroundColor: "var(--gs-base)",
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    // Reveal the clipped gradient via text-fill-color (not `color:
    // transparent`) so `currentColor` in `--gs-base` still resolves to the
    // real text color.
    WebkitTextFillColor: "transparent",
    "--gs-base": BASE_COLOR,
    "--gs-spread": `${initialSpread}px`,
    "--gs-spread-mid": `${initialSpread * SPREAD_MID_RATIO}px`,
  } as CSSProperties;

  return (
    <span
      ref={ref}
      className={className}
      style={style}
      data-testid={dataTestId}
    >
      {children}
    </span>
  );
}
