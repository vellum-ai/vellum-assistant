/**
 * The notification-ready avatar: the assistant's avatar on an accent-tinted
 * disc, the icon a native notification shows as the sender.
 *
 * The disc is inscribed in the 256x256 square, so the four corners come out
 * fully transparent while the disc and everything inside it is opaque. Every
 * consumer circle-crops what it is handed, so the transparent corners are the
 * intended output, not a gap the render failed to fill.
 *
 * The geometry, the disc colour, and the byte cap come from
 * `@vellumai/avatar-manifest` so the daemon, the desktop renderer, and every
 * mobile client draw the same picture. This module only resolves the current
 * avatar and rasterizes it.
 *
 * Best-effort throughout: a missing raster, an undecodable upload, a missing
 * native rasterizer, or a render too heavy to fit the cap yields null so
 * callers keep whatever the platform already holds rather than blanking it.
 */

import {
  NOTIFICATION_AVATAR_MAX_BYTES,
  NOTIFICATION_AVATAR_SIZE,
  notificationAvatarSvg,
} from "@vellumai/avatar-manifest/notification-avatar";

import { detectMediaType } from "../tools/shared/filesystem/image-read.js";
import { getLogger } from "../util/logger.js";
import { paletteAccent } from "./avatar-accent.js";
import { type AvatarState, readAvatarState } from "./avatar-manifest.js";
import { ensureAvatarRaster } from "./ensure-raster.js";
import {
  getResvg,
  isResvgAvailable,
  isResvgDecodableType,
} from "./resvg-lazy.js";

const log = getLogger("notification-avatar");

/**
 * The accent the disc is tinted with. A character built before accents were
 * persisted carries none in its manifest, so its palette colour stands in.
 */
export function resolveNotificationAccentHex(
  state: AvatarState,
): string | null {
  if (state.accent) {
    return state.accent.hex;
  }
  if (state.kind === "character" && state.traits) {
    return paletteAccent(state.traits.color)?.hex ?? null;
  }
  return null;
}

/**
 * Re-encodes an oversized render as a 256-colour palette PNG. A photographic
 * upload is the only thing that reaches the cap, and quantising it is far
 * cheaper for the wire than the ~200 KB of noise a truecolour PNG keeps.
 */
async function quantize(png: Buffer): Promise<Buffer | null> {
  try {
    const { default: sharp } = await import("sharp");
    return await sharp(png, { failOn: "error" })
      .png({ palette: true, quality: 80 })
      .toBuffer();
  } catch (err) {
    log.warn({ err }, "Could not quantize the oversized notification avatar");
    return null;
  }
}

/**
 * Renders the current avatar as a 256x256 notification PNG whose corners are
 * transparent by design, or null when there is no avatar, its raster is
 * unreadable or in a format resvg cannot decode (a WebP upload), the native
 * rasterizer is unavailable, or the result will not fit
 * `NOTIFICATION_AVATAR_MAX_BYTES`.
 *
 * `raster` short-circuits the avatar-raster lookup for a caller that already
 * holds the bytes; without it the raster is resolved from `state`.
 */
export async function renderNotificationAvatarPng(
  state: AvatarState = readAvatarState(),
  raster?: Buffer,
): Promise<Buffer | null> {
  if (state.kind === "none" || !isResvgAvailable()) {
    return null;
  }
  const bytes = raster ?? (await ensureAvatarRaster(state));
  if (!bytes) {
    return null;
  }
  const mediaType = detectMediaType(bytes);
  if (!isResvgDecodableType(mediaType)) {
    log.warn(
      { mediaType },
      "Avatar raster format is not decodable by resvg; skipping the notification avatar",
    );
    return null;
  }

  let png: Buffer | null;
  try {
    const Resvg = getResvg();
    const resvg = new Resvg(
      notificationAvatarSvg({
        innerPngBase64: bytes.toString("base64"),
        innerMediaType: mediaType,
        accentHex: resolveNotificationAccentHex(state),
      }),
      { fitTo: { mode: "width", value: NOTIFICATION_AVATAR_SIZE } },
    );
    png = Buffer.from(resvg.render().asPng());
  } catch (err) {
    log.warn({ err }, "Failed to render the notification avatar");
    return null;
  }

  if (png.length > NOTIFICATION_AVATAR_MAX_BYTES) {
    png = await quantize(png);
  }
  if (!png || png.length > NOTIFICATION_AVATAR_MAX_BYTES) {
    log.warn(
      { bytes: png?.length, cap: NOTIFICATION_AVATAR_MAX_BYTES },
      "Notification avatar exceeds the size cap; skipping it",
    );
    return null;
  }
  return png;
}
