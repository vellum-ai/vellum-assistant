/**
 * Foreground tone for surfaces painted with an avatar color.
 *
 * Screens that fill their background with an assistant's avatar color (the
 * avatar-tinted onboarding steps, the voice room) need a foreground that
 * contrasts: white on the dark/saturated palette colors, near-black on the
 * light one (yellow). `toneForBg` derives that once from the background's
 * perceived brightness so every surface reads the same `fg`/`fgMuted` instead
 * of hard-coding white.
 */

export interface SurfaceTone {
  /** Background hex the tone was derived for. */
  bg: string;
  /** True when the background is light enough to need dark foreground. */
  isLight: boolean;
  /** Foreground color: black on light bg, white otherwise. */
  fg: string;
  /**
   * A deeper heading foreground: the background color itself, darkened.
   * Reads as a secondary tone of the same hue.
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
  if (!m) return 0;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (r * 299 + g * 587 + b * 114) / 1000 / 255;
}

/** Multiply each channel of a #rrggbb hex by `factor` (clamped 0–255). */
function darkenHex(hex: string, factor: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const ch = (shift: number) =>
    Math.max(0, Math.min(255, Math.round(((n >> shift) & 0xff) * factor)));
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

/** Build a tone object from a background hex. */
export function toneForBg(bg: string): SurfaceTone {
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
