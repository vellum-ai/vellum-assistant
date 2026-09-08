/**
 * The notification-ready avatar: the assistant's avatar on an opaque
 * accent-tinted disc, the icon a native notification shows as the sender.
 *
 * The geometry and the disc colour come from `@vellumai/avatar-manifest` so
 * the daemon, the desktop renderer, and every mobile client draw the same
 * picture. This module only resolves the current avatar and rasterizes it.
 *
 * Best-effort throughout: a missing raster, an undecodable upload, or a
 * missing native rasterizer yields null so callers keep whatever the platform
 * already holds rather than blanking it.
 */

import {
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
function resolveAccentHex(state: AvatarState): string | null {
  if (state.accent) {
    return state.accent.hex;
  }
  if (state.kind === "character" && state.traits) {
    return paletteAccent(state.traits.color)?.hex ?? null;
  }
  return null;
}

/**
 * Renders the current avatar as a 256x256 notification PNG, or null when
 * there is no avatar, its raster is unreadable or in a format resvg cannot
 * decode (a WebP upload), or the native rasterizer is unavailable.
 */
export async function renderNotificationAvatarPng(
  state: AvatarState = readAvatarState(),
): Promise<Buffer | null> {
  if (state.kind === "none" || !isResvgAvailable()) {
    return null;
  }
  const bytes = await ensureAvatarRaster(state);
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

  try {
    const Resvg = getResvg();
    const resvg = new Resvg(
      notificationAvatarSvg({
        innerPngBase64: bytes.toString("base64"),
        innerMediaType: mediaType,
        accentHex: resolveAccentHex(state),
      }),
      { fitTo: { mode: "width", value: NOTIFICATION_AVATAR_SIZE } },
    );
    return Buffer.from(resvg.render().asPng());
  } catch (err) {
    log.warn({ err }, "Failed to render the notification avatar");
    return null;
  }
}
