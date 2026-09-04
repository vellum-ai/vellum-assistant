/**
 * The avatar accent: the one colour every surface that tints itself to the
 * assistant paints with.
 *
 * A character avatar's accent is its palette colour. An uploaded image has no
 * colour as data, so one is read out of its pixels here. Pure pixel math with
 * no decoder: the daemon feeds it a raster decoded by sharp and the web feeds
 * it a canvas, and because both go through this one function they cannot
 * disagree about what colour an image is.
 */

/** `#rrggbb` only: the one form CSS, the native hex parsers, and the colour picker all agree on. */
const ACCENT_HEX_PATTERN = /^#[0-9a-f]{6}$/i;

/** Whether `value` is a `#rrggbb` string. */
export function isAvatarAccentHex(value: unknown): value is string {
  return typeof value === "string" && ACCENT_HEX_PATTERN.test(value);
}

/**
 * Canonical form of an accent hex (`#rrggbb`, lowercase), or null when the
 * input is not one. Surrounding whitespace is tolerated because the value can
 * arrive from a text field.
 */
export function normalizeAvatarAccentHex(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return ACCENT_HEX_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** Pixels below this alpha are skipped: a cutout's transparent ground is not its colour. */
const MIN_ALPHA = 128;

/** Hue is bucketed this finely, so a gradient of one hue lands in one bin. */
const HUE_BINS = 24;
/** Chromatic bins are split by lightness this many ways, so a colour and its shadow stay apart. */
const LIGHT_BANDS = 3;
/** Below this saturation a pixel is counted as gray, bucketed by lightness alone. */
const GRAY_SATURATION = 0.15;
/** Gray bins by lightness. */
const GRAY_BANDS = 5;

interface Bin {
  count: number;
  r: number;
  g: number;
  b: number;
  s: number;
  l: number;
}

function rgbToHsl(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) {
    return { h: 0, s: 0, l };
  }
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) {
    h = ((gn - bn) / d) % 6;
  } else if (max === gn) {
    h = (bn - rn) / d + 2;
  } else {
    h = (rn - gn) / d + 4;
  }
  h /= 6;
  return { h: h < 0 ? h + 1 : h, s, l };
}

function toHex(r: number, g: number, b: number): string {
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${((1 << 24) | (ch(r) << 16) | (ch(g) << 8) | ch(b)).toString(16).slice(1)}`;
}

/**
 * How much a bin's colour deserves to be the accent, per pixel in it.
 *
 * Population alone picks the background: most uploads are a subject on white
 * or black. Saturation and mid lightness weight the bin instead, so a red mark
 * on a white ground reads as red while an all-gray photo still reads as gray,
 * because with nothing colourful to beat, the gray bin's small weight wins.
 */
function salience(s: number, l: number): number {
  return (0.1 + 0.9 * s) * Math.max(0.1, 1 - Math.abs(l - 0.5) * 1.6);
}

/**
 * The most prevalent accent colour in a block of RGBA pixels, as `#rrggbb`, or
 * null when no pixel is opaque enough to count.
 *
 * Pixels are bucketed by hue and lightness (grays by lightness alone), each
 * bucket is scored by population times how much it looks like an accent
 * (saturated, mid-toned), and the winner's mean colour is the answer. The
 * mean rather than the bucket centre, so a brand's exact orange comes back
 * as that orange and not the nearest of twenty-four hues.
 */
export function dominantAccentHex(pixels: ArrayLike<number>): string | null {
  const bins = new Map<number, Bin>();
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3]! < MIN_ALPHA) {
      continue;
    }
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const { h, s, l } = rgbToHsl(r, g, b);
    const key =
      s < GRAY_SATURATION
        ? -1 - Math.min(GRAY_BANDS - 1, Math.floor(l * GRAY_BANDS))
        : Math.min(HUE_BINS - 1, Math.floor(h * HUE_BINS)) * LIGHT_BANDS +
          Math.min(LIGHT_BANDS - 1, Math.floor(l * LIGHT_BANDS));
    let bin = bins.get(key);
    if (!bin) {
      bin = { count: 0, r: 0, g: 0, b: 0, s: 0, l: 0 };
      bins.set(key, bin);
    }
    bin.count += 1;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bin.s += s;
    bin.l += l;
  }

  let best: Bin | null = null;
  let bestScore = -1;
  for (const bin of bins.values()) {
    const score = bin.count * salience(bin.s / bin.count, bin.l / bin.count);
    if (score > bestScore) {
      best = bin;
      bestScore = score;
    }
  }
  if (!best) {
    return null;
  }
  return toHex(best.r / best.count, best.g / best.count, best.b / best.count);
}
