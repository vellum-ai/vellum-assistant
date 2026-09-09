/**
 * Colour work on an uploaded avatar image, in the browser.
 *
 * The daemon reads an uploaded image's accent out of its pixels and serves it
 * with the avatar manifest; {@link sampleAvatarAccentHex} runs the same maths
 * (`dominantAccentHex`, shared through `@vellumai/avatar-manifest`) on a
 * canvas for assistants that predate accents, so the two can never disagree
 * about what colour an image is.
 *
 * {@link normalizeFieldHex} is the room's treatment of that accent. A raw
 * accent is usually too bright or too dark to be a background anything can be
 * drawn on, so the fill keeps the hue and pins the perceived brightness into
 * the band the character palette occupies, which is the band avatar-tinted
 * treatments are tuned against.
 */

import { dominantAccentHex } from "@vellumai/avatar-manifest/accent";

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
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
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
 * Pin an accent into the band avatar-tinted surfaces are drawn for: the hue
 * is kept, the saturation is capped, and the perceived brightness is set to
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
 * Sample `src` (a renderer-owned blob URL or a data URI) down to a small
 * offscreen canvas and return its accent, or null when the image cannot be
 * read.
 *
 * Null covers every failure the caller has to survive: a decode error, an
 * image with no extent, a browser that hands back no 2D context, and a remote
 * URL served without CORS headers, which taints the canvas so `getImageData`
 * throws. Every one of them means "no color to paint with", never a thrown
 * error: this drives decoration, and a decorative sample must not be able to
 * take a surface down.
 *
 * Non-square uploads are center-cropped with {@link coverCropSquare}, the same
 * crop `ChatAvatar` renders and the daemon samples, so the sample comes from
 * the pixels the user can actually see rather than from bands that are
 * cropped away.
 */
export async function sampleAvatarAccentHex(
  src: string,
  size = 48,
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
    ctx.drawImage(
      image,
      crop.sx,
      crop.sy,
      crop.side,
      crop.side,
      0,
      0,
      size,
      size,
    );
    return dominantAccentHex(ctx.getImageData(0, 0, size, size).data);
  } catch {
    return null;
  }
}
