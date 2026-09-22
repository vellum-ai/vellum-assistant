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
 * A WebP upload is transcoded to PNG first, since resvg has no decoder for it,
 * and that transcode needs sharp, whose native binary an install can be
 * missing even though the package itself is a plain dependency.
 */

import type { NotificationAvatarMediaType } from "@vellumai/avatar-manifest/notification-avatar";
import {
  NOTIFICATION_AVATAR_MAX_BYTES,
  NOTIFICATION_AVATAR_SIZE,
  notificationAvatarSvg,
} from "@vellumai/avatar-manifest/notification-avatar";
import type sharpDefault from "sharp";

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

type SharpFactory = typeof sharpDefault;

/** Undefined until the first load; the codec or null afterwards. */
let sharpFactory: SharpFactory | null | undefined;

/**
 * The image codec, or null when its native binary is missing on this platform.
 * Loaded lazily and remembered, so the availability check the sync's dedupe
 * key asks for costs one import at most.
 */
async function getSharp(): Promise<SharpFactory | null> {
  if (sharpFactory === undefined) {
    try {
      sharpFactory = (await import("sharp")).default ?? null;
    } catch (err) {
      log.warn(
        { err },
        "sharp is unavailable; avatar transcoding and quantising are off",
      );
      sharpFactory = null;
    }
  }
  return sharpFactory;
}

/** Test-only hook to reset the cached codec between test cases. */
export function __resetSharpCacheForTests(): void {
  sharpFactory = undefined;
}

/**
 * Test-only hook to force the cached codec without exercising the real
 * import, so the missing-codec path can be asserted on a machine that has it.
 */
export function __setSharpCacheForTests(factory: SharpFactory | null): void {
  sharpFactory = factory;
}

/**
 * Re-encodes an oversized render as a 256-colour palette PNG. A photographic
 * upload is the only thing that reaches the cap, and quantising it is far
 * cheaper for the wire than the truecolour PNG's per-pixel noise.
 */
async function quantize(png: Buffer): Promise<Buffer | null> {
  const sharp = await getSharp();
  if (!sharp) {
    return null;
  }
  try {
    return await sharp(png, { failOn: "error" })
      .png({ palette: true, quality: 80 })
      .toBuffer();
  } catch (err) {
    log.warn({ err }, "Could not quantize the oversized notification avatar");
    return null;
  }
}

/**
 * How a sniffed raster reaches resvg. resvg has no WebP decoder and renders
 * such an `<image>` href blank, so a WebP upload (which the upload route
 * accepts) has to go through sharp first; anything else it cannot decode has
 * nowhere to go.
 */
type ResvgRoute =
  | { via: "href"; mediaType: NotificationAvatarMediaType }
  | { via: "transcode" }
  | { via: "none"; mediaType: string | null };

function routeRaster(bytes: Buffer): ResvgRoute {
  const mediaType = detectMediaType(bytes);
  if (isResvgDecodableType(mediaType)) {
    return { via: "href", mediaType };
  }
  if (mediaType === "image/webp") {
    return { via: "transcode" };
  }
  return { via: "none", mediaType };
}

interface ResvgSource {
  bytes: Buffer;
  mediaType: NotificationAvatarMediaType;
}

/** The raster in a form resvg can draw, or null when there is none. */
async function toResvgSource(bytes: Buffer): Promise<ResvgSource | null> {
  const route = routeRaster(bytes);
  if (route.via === "href") {
    return { bytes, mediaType: route.mediaType };
  }
  if (route.via === "none") {
    log.warn(
      { mediaType: route.mediaType },
      "Avatar raster format is not decodable by resvg; skipping the notification avatar",
    );
    return null;
  }
  const sharp = await getSharp();
  if (!sharp) {
    return null;
  }
  try {
    const png = await sharp(bytes, { failOn: "error" }).png().toBuffer();
    return { bytes: png, mediaType: "image/png" };
  } catch (err) {
    log.warn({ err }, "Could not transcode the WebP avatar to PNG");
    return null;
  }
}

/**
 * Whether a disc can be drawn for `raster` right now: the native rasterizer is
 * present and the source is one it can decode, directly or through a
 * transcode. Answered without rendering, so the platform sync can fold it into
 * a dedupe key and re-upload once a missing rasterizer or codec appears
 * instead of latching the sync that shipped no disc.
 */
export async function canRenderNotificationAvatar(
  raster: Buffer,
): Promise<boolean> {
  if (!isResvgAvailable()) {
    return false;
  }
  const route = routeRaster(raster);
  if (route.via === "href") {
    return true;
  }
  if (route.via === "none") {
    return false;
  }
  const sharp = await getSharp();
  return !!sharp;
}

/**
 * Renders the current avatar as a 256x256 notification PNG whose corners are
 * transparent by design, or null when there is no avatar, its raster is
 * unreadable or in a format nothing here can decode, the native rasterizer is
 * unavailable, or the result will not fit `NOTIFICATION_AVATAR_MAX_BYTES`.
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
  const source = await toResvgSource(bytes);
  if (!source) {
    return null;
  }

  let png: Buffer | null;
  try {
    const Resvg = getResvg();
    const resvg = new Resvg(
      notificationAvatarSvg({
        innerPngBase64: source.bytes.toString("base64"),
        innerMediaType: source.mediaType,
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
