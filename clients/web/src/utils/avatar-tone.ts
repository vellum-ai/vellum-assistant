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
  /**
   * Soft raised-surface fill for a user speech bubble — the room's analog of
   * the app's `--surface-lift`: a translucent lift of the foreground over the
   * avatar color (a subtle white wash over dark/saturated avatars, a subtle
   * dark wash over the light one), not an opaque max-contrast chip.
   */
  bubbleBg: string;
  /**
   * Text color for that bubble, chosen for WCAG-AA contrast against the
   * *blended* bubble pixel (the lift composited over the avatar fill) — white
   * over dark avatars, near-black over lighter/mid-tone ones — so live captions
   * stay legible on every palette color, not a fixed room foreground.
   */
  bubbleFg: string;
}

const FG_DARK = "#1A1A1A";
const FG_LIGHT = "#FFFFFF";

/** Near-black ground that avatar-tinted full-bleed surfaces blend over. */
export const SURFACE_GROUND = "#151515";

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

/**
 * Composite `overlay` at `alpha` over the solid `base`, returning the resulting
 * opaque #rrggbb. Either hex may carry a leading `#`; a malformed input returns
 * `base` unchanged, and `alpha` is clamped to 0–1.
 */
export function blendHex(base: string, overlay: string, alpha: number): string {
  const b = /^#?([0-9a-f]{6})$/i.exec(base);
  const o = /^#?([0-9a-f]{6})$/i.exec(overlay);
  if (!b || !o) {
    return base;
  }
  const a = Math.max(0, Math.min(1, alpha));
  const bn = parseInt(b[1]!, 16);
  const on = parseInt(o[1]!, 16);
  const mix = (shift: number) =>
    Math.round(((bn >> shift) & 0xff) * (1 - a) + ((on >> shift) & 0xff) * a);
  return `#${((1 << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).slice(1)}`;
}

/**
 * Deep full-bleed surface for an avatar accent: the accent washed over
 * {@link SURFACE_GROUND}. 0.14 is calibrated so the green character reproduces
 * the takeover's established `#1D271E`.
 */
export function avatarSurfaceHex(accentHex: string): string {
  return blendHex(SURFACE_GROUND, accentHex, 0.14);
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

/** WCAG contrast ratio between two #rrggbb hexes, 1 to 21. */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * {@link FG_DARK} or {@link FG_LIGHT}, whichever has the higher WCAG contrast
 * ratio against `bg`. An exact tie takes the light one.
 *
 * Both ratios are measured against the two values this returns, not against
 * pure black and white. A near-black loses to white at a lower background
 * luminance than #000000 does, so a luminance cutoff read off the pure pair
 * hands dark ink to a band of mid-tone backgrounds that white reads better on.
 *
 * Stricter than {@link toneForBg}'s YIQ heuristic, which gives white to the
 * mid-tone saturated colors (teal, orange) that want dark text. Use for text
 * that must stay readable on a solid fill of the avatar color.
 */
export function contrastForeground(bg: string): string {
  return contrastRatio(FG_DARK, bg) > contrastRatio(FG_LIGHT, bg)
    ? FG_DARK
    : FG_LIGHT;
}

/** WCAG AA for text below the large-text sizes, which is all of this ink. */
const TEXT_CONTRAST_FLOOR = 4.5;

/**
 * The luminance window in which NEITHER ink clears the floor.
 *
 * Two inks give two passing regions and a gap between them: white carries a
 * background up to the luminance where 1.05 over it falls to the floor, and the
 * near-black carries one down to where the floor times its own luminance is
 * reached. Mid-tones sit in the gap, and no choice between two values gets
 * them out of it.
 */
const WHITE_INK_MAX_LUMINANCE = 1.05 / TEXT_CONTRAST_FLOOR - 0.05;
const DARK_INK_MIN_LUMINANCE =
  TEXT_CONTRAST_FLOOR * (relativeLuminance(FG_DARK) + 0.05) - 0.05;
const FLOOR_GAP_MIDPOINT =
  (WHITE_INK_MAX_LUMINANCE + DARK_INK_MIN_LUMINANCE) / 2;

/** Whether {@link contrastForeground}'s answer clears the floor on `bg`. */
function meetsTextFloor(bg: string): boolean {
  return contrastRatio(contrastForeground(bg), bg) >= TEXT_CONTRAST_FLOOR;
}

/** How finely {@link legibleAccentFill} steps toward the nearer edge. */
const FILL_ADJUST_STEPS = 100;

/**
 * `accentHex` if text can sit on it, otherwise the nearest colour that text
 * can sit on: the accent walked toward black or toward white until
 * {@link contrastForeground}'s answer clears {@link TEXT_CONTRAST_FLOOR}.
 *
 * For a surface FILLED with an avatar accent, since an accent is any colour a
 * palette, an image or a user hands over, and the mid-tones between the two
 * inks' passing regions carry no readable text at all. Chrome that sits OVER
 * video rather than under text takes the raw accent instead: a ring or a line
 * has no foreground to fail.
 *
 * The direction is whichever edge of the gap is nearer in luminance, so the
 * fill moves as little as it can and keeps its hue; darkening scales the
 * channels and lightening washes toward white, which are the same two moves
 * the room's other accent surfaces make. Both edges are reachable (black and
 * white each clear the floor against one ink), so the walk always lands.
 */
export function legibleAccentFill(accentHex: string): string {
  if (meetsTextFloor(accentHex)) {
    return accentHex;
  }
  const darker = relativeLuminance(accentHex) < FLOOR_GAP_MIDPOINT;
  let fill = accentHex;
  for (let step = 1; step <= FILL_ADJUST_STEPS; step++) {
    const amount = step / FILL_ADJUST_STEPS;
    fill = darker
      ? darkenHex(accentHex, 1 - amount)
      : blendHex(accentHex, FG_LIGHT, amount);
    if (meetsTextFloor(fill)) {
      break;
    }
  }
  return fill;
}

/** Build a tone object from a background hex. */
export function toneForBg(bg: string): AvatarTone {
  const isLight = brightness(bg) > 0.6;
  const fg = isLight ? FG_DARK : FG_LIGHT;
  return {
    bg,
    isLight,
    fg,
    fgDeep: darkenHex(bg, 0.6),
    fgMuted: isLight ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.65)",
    wash: isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.12)",
    // A soft raised surface (the room's analog of the app's --surface-lift user
    // bubble): a translucent lift of the foreground over the avatar color — not
    // an opaque max-contrast chip. Its text is chosen for WCAG-AA contrast
    // against the *blended* bubble pixel (lift over the avatar fill), so mid-tone
    // saturated avatars get near-black text instead of failing white-on-color.
    bubbleBg: isLight ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.16)",
    bubbleFg: isLight
      ? contrastForeground(blendHex(bg, "#000000", 0.1))
      : contrastForeground(blendHex(bg, "#ffffff", 0.16)),
  };
}
