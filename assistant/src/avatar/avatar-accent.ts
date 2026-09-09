/**
 * Reading an accent colour out of an avatar image.
 *
 * The colour maths is `dominantAccentHex` in `@vellumai/avatar-manifest`,
 * shared with the web so both sides agree on what colour an image is. This
 * module only decodes: sharp turns the upload into a small square of RGBA
 * pixels, centre-cropped the way the avatar is drawn, so the sample comes from
 * the pixels the user actually sees.
 */
import { accentHexForColorId } from "@vellumai/avatar-catalog/colors";
import {
  type AvatarAccent,
  dominantAccentHex,
} from "@vellumai/avatar-manifest";

import { getLogger } from "../util/logger.js";

const log = getLogger("avatar-accent");

/** Side of the square the image is sampled at; enough for a histogram, cheap to decode to. */
const SAMPLE_SIZE = 48;

/**
 * The dominant accent of an image, or null when the bytes cannot be decoded
 * or hold no opaque pixel. Never throws: the accent decorates surfaces, and a
 * decode failure must not fail the upload that carried the image.
 */
export async function deriveAccentHexFromImage(
  bytes: Buffer,
): Promise<string | null> {
  try {
    const { default: sharp } = await import("sharp");
    const { data } = await sharp(bytes, { failOn: "error" })
      .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: "cover" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return dominantAccentHex(data);
  } catch (err) {
    log.warn(
      { err },
      "Could not read an accent colour out of the avatar image",
    );
    return null;
  }
}

/** The accent a character wears: its palette colour. Null for an id the palette lacks. */
export function paletteAccent(colorId: string): AvatarAccent | null {
  const hex = accentHexForColorId(colorId);
  return hex ? { hex, source: "palette" } : null;
}

/** The accent read out of an image's pixels, or null when there was none to read. */
export function derivedAccent(hex: string | null): AvatarAccent | null {
  return hex ? { hex, source: "derived" } : null;
}
