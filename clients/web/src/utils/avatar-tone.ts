/**
 * Foreground tone for surfaces painted with an assistant avatar's color.
 *
 * Avatar-tinted pages (research onboarding, the About Assistant overview
 * and personality pages) paint the background with the avatar's color, so
 * UI drawn on top (titles, labels, controls) needs a foreground that
 * contrasts: white on the dark/saturated colors, black on the light one
 * (yellow). `toneForBg` derives that once from the color's perceived
 * brightness, so every surface can read the same `fg`/`fgMuted` instead of
 * hard-coding white.
 */

export interface AvatarTone {
  /** Background hex (the avatar color), or a surface fallback. */
  bg: string;
  /** True when the background is light enough to need dark foreground. */
  isLight: boolean;
  /** Foreground color: black on light bg, white otherwise. */
  fg: string;
  /**
   * A deeper heading foreground: the background color itself, darkened.
   * Reads as a secondary tone against the matching background.
   */
  fgDeep: string;
  /** Muted/secondary foreground at the matching tone. */
  fgMuted: string;
  /** A subtle hover/fill wash at the matching tone. */
  wash: string;
}

const FG_DARK = "#1A1A1A";
const FG_LIGHT = "#FFFFFF";

/** Perceived brightness (YIQ), 0–1. */
function brightness(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) {
    return 0;
  }
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (r * 299 + g * 587 + b * 114) / 1000 / 255;
}

/** Multiply each channel of a #rrggbb hex by `factor` (clamped 0–255). */
export function darkenHex(hex: string, factor: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) {
    return hex;
  }
  const n = parseInt(m[1]!, 16);
  const ch = (shift: number) =>
    Math.max(0, Math.min(255, Math.round(((n >> shift) & 0xff) * factor)));
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

/** WCAG relative luminance (sRGB-linearized), 0–1. */
function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) {
    return 0;
  }
  const n = parseInt(m[1]!, 16);
  const ch = (shift: number) => {
    const c = ((n >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0);
}

/**
 * Black or white, whichever has the higher WCAG contrast ratio against
 * `bg`. Stricter than {@link toneForBg}'s YIQ heuristic — mid-tone
 * saturated colors (teal, orange) correctly get dark text here, where the
 * YIQ rule would pick white. Use for text that must stay readable on a
 * solid fill of the avatar color.
 */
export function contrastForeground(bg: string): string {
  // White wins only below L ≈ 0.179 — the point where (L + 0.05)² = 0.0525.
  return relativeLuminance(bg) > 0.179 ? FG_DARK : FG_LIGHT;
}

/** Build a tone object from a background hex. */
export function toneForBg(bg: string): AvatarTone {
  const isLight = brightness(bg) > 0.6;
  return {
    bg,
    isLight,
    fg: isLight ? FG_DARK : FG_LIGHT,
    fgDeep: darkenHex(bg, 0.6),
    fgMuted: isLight ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.65)",
    wash: isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.12)",
  };
}
