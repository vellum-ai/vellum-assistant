/**
 * Deriving a room-fill color from a custom (uploaded) avatar image.
 *
 * A character avatar hands every avatar-tinted surface an explicit palette
 * color to paint with. An uploaded image hands over pixels instead, so a
 * surface that fills itself with "the assistant's color" has to sample one out
 * of those pixels. That is what this does: one representative color, so an
 * uploaded avatar drives the same surfaces a character does.
 *
 * The sample is normalized rather than used raw: a photograph's average is
 * usually a washed-out near-white or a muddy near-black, neither of which is a
 * background anything can be drawn on. {@link normalizeFieldHex} keeps the
 * sampled hue and pins the perceived brightness into the band the character
 * palette occupies, which is the band avatar-tinted treatments are tuned
 * against.
 */

import { coverCropSquare } from "./avatar-raster";

/**
 * Perceived brightness the field is pinned to, matching the character palette's
 * own range (its darkest color, teal, sits at ~0.44). Treatments drawn over an
 * avatar color assume that band: pale ink reads on it, and so does dark ink.
 *
 * Perceived, not HSL lightness: the eye weights green far above blue, so a
 * fixed lightness leaves a saturated blue at roughly half the brightness of a
 * saturated yellow, dark enough that the dark ink drawn over it disappears.
 */
const FIELD_BRIGHTNESS = 0.45;

/**
 * Saturation ceiling. A logo built from one fully-saturated ink samples at
 * S = 1, which as a full-screen field is a headache rather than a backdrop.
 * There is deliberately no floor: a grayscale avatar earns a gray room.
 */
const FIELD_MAX_SATURATION = 0.68;

/** Pixels below this alpha are skipped: a transparent logo's ground is not its color. */
const MIN_ALPHA = 128;

/**
 * How strongly a pixel's colorfulness weights it in the average.
 *
 * A flat average is dominated by whatever fills the most area, which for most
 * uploads is a white or black background, so the "avatar color" of a red logo
 * on white comes out pale pink. Weighting by chroma lets the colored pixels
 * carry the result while the base weight keeps a genuinely gray image gray.
 */
const CHROMA_WEIGHT = 4;
const BASE_WEIGHT = 0.25;

/** Parse `#rgb` / `#rrggbb` into 0-255 channels; null when malformed. */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) {
    return null;
  }
  const h = m[1]!;
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex(r: number, g: number, b: number): string {
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${((1 << 24) | (ch(r) << 16) | (ch(g) << 8) | ch(b)).toString(16).slice(1)}`;
}

/** RGB (0-255) to HSL (all 0-1). */
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

/** HSL (all 0-1) back to RGB (0-255). */
function hslToRgb(
  h: number,
  s: number,
  l: number,
): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

/** Perceived brightness (YIQ), 0-1: the measure `toneForBg` judges a fill by. */
function brightness(r: number, g: number, b: number): number {
  return (r * 299 + g * 587 + b * 114) / 1000 / 255;
}

/**
 * The `h`/`s` color whose perceived brightness is `target`.
 *
 * Brightness climbs monotonically with lightness at a fixed hue and saturation,
 * so this bisects for it. Inverting the piecewise HSL conversion analytically
 * would mean a case per hue sector for no gain: twenty halvings land within a
 * thousandth of a channel step.
 */
function hexAtBrightness(h: number, s: number, target: number): string {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    if (brightness(...hslToRgb(h, s, mid)) < target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return toHex(...hslToRgb(h, s, (lo + hi) / 2));
}

/**
 * Pin a sampled color into the band avatar-tinted surfaces are drawn for: the
 * hue is kept, the saturation is capped, and the perceived brightness is set to
 * {@link FIELD_BRIGHTNESS}. Returns the input unchanged if it is not a hex.
 */
export function normalizeFieldHex(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) {
    return hex;
  }
  const { h, s } = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  return hexAtBrightness(
    h,
    Math.min(s, FIELD_MAX_SATURATION),
    FIELD_BRIGHTNESS,
  );
}

/**
 * One representative color for a block of RGBA pixels, normalized per
 * {@link normalizeFieldHex}. Null when the block holds no pixel opaque enough
 * to count (an all-transparent crop), so the caller keeps its own fallback.
 *
 * Split out from the canvas work so the color math is testable without a DOM.
 */
export function fieldHexFromImageData(data: Uint8ClampedArray): string | null {
  let totalWeight = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const alpha = data[i + 3]!;
    if (alpha < MIN_ALPHA) {
      continue;
    }
    const pr = data[i]!;
    const pg = data[i + 1]!;
    const pb = data[i + 2]!;
    const chroma =
      (Math.max(pr, pg, pb) - Math.min(pr, pg, pb)) / 255;
    const weight = BASE_WEIGHT + chroma * CHROMA_WEIGHT;
    totalWeight += weight;
    r += pr * weight;
    g += pg * weight;
    b += pb * weight;
  }
  if (totalWeight === 0) {
    return null;
  }
  return normalizeFieldHex(
    toHex(r / totalWeight, g / totalWeight, b / totalWeight),
  );
}

/**
 * Sample `src` (a renderer-owned blob URL or a data URI) down to a small
 * offscreen canvas and return its field color, or null when the image cannot
 * be read.
 *
 * Null covers every failure the caller has to survive: a decode error, an
 * image with no extent, a browser that hands back no 2D context, and a remote
 * URL served without CORS headers, which taints the canvas so `getImageData`
 * throws. Every one of them means "no color to paint with", never a thrown
 * error: this drives decoration, and a decorative sample must not be able to
 * take a surface down.
 *
 * Non-square uploads are center-cropped with {@link coverCropSquare}, the same
 * crop `ChatAvatar` renders, so the sample comes from the pixels the user can
 * actually see rather than from bands that are cropped away.
 */
export async function sampleAvatarFieldHex(
  src: string,
  size = 24,
): Promise<string | null> {
  if (!src || typeof document === "undefined") {
    return null;
  }
  const image = new Image();
  image.decoding = "async";
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("avatar image failed to load"));
  });
  try {
    image.src = src;
    await loaded;
    const crop = coverCropSquare(image.naturalWidth, image.naturalHeight);
    if (!crop) {
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return null;
    }
    ctx.drawImage(image, crop.sx, crop.sy, crop.side, crop.side, 0, 0, size, size);
    return fieldHexFromImageData(ctx.getImageData(0, 0, size, size).data);
  } catch {
    return null;
  }
}
