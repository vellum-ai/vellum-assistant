/**
 * The notification avatar: the assistant's avatar centered on an accent-tinted
 * disc, the icon a native notification shows as the sender.
 *
 * The disc is inscribed in the square, so the four corners stay transparent.
 * That is deliberate: iOS, Android, and the Windows toast logo slot all
 * circle-crop what they are handed, and a square of colour behind the disc
 * would only show through as a ring on any surface that does not crop. The
 * disc itself is fully opaque, and so is everything inside it.
 *
 * Every platform draws the same picture with a different rasterizer (resvg in
 * the daemon, a canvas in the desktop renderer), so the geometry and the disc
 * colour live here once. Pure arithmetic and string building, no decoder and
 * no node builtins, so a browser can call it too.
 */

import { isAvatarAccentHex } from "./accent.js";

/** Output edge in pixels: large enough for an iOS notification thumbnail. */
export const NOTIFICATION_AVATAR_SIZE = 256;

/** Free disc on each side, as a fraction of the edge; the avatar gets the rest. */
export const NOTIFICATION_AVATAR_INSET = 0.11;

/** The disc when the assistant has no accent. */
export const NOTIFICATION_AVATAR_FALLBACK_DISC_HEX = "#ECEFEA";

/** How much of the accent survives the mix into white. */
const ACCENT_MIX = 0.14;

/**
 * Largest notification PNG the platform sync ships, in bytes. It bounds the
 * `notification_avatar_base64` field of the PATCH that uploads the disc, which
 * is what APNs and FCM later hand their clients a URL and a hash for. A
 * photographic avatar is quantised (or dropped) to fit.
 */
export const NOTIFICATION_AVATAR_MAX_BYTES = 128 * 1024;

/**
 * Largest notification PNG the local desktop path carries, in bytes. The
 * renderer composites the disc, hands it to the Electron host over IPC and the
 * host caches it on disk, so nothing crosses a push transport and a
 * photographic avatar that renders past the sync cap still shows.
 */
export const NOTIFICATION_AVATAR_MAX_LOCAL_BYTES = 512 * 1024;

/**
 * Bumped whenever the drawing above changes, so a sync keyed on it re-uploads
 * a disc rendered by an older spec even when the avatar itself is unchanged.
 */
export const NOTIFICATION_AVATAR_SPEC_VERSION = 1;

/** The id the inner raster's clip path is referenced by inside the document. */
const CLIP_ID = "notification-avatar-disc";

/**
 * The disc fill for an accent: the accent mixed into white, so the avatar reads
 * against it at notification size. Uppercase `#RRGGBB`; the neutral fallback
 * when there is no accent or the value is not a hex.
 */
export function notificationAvatarDiscHex(accentHex: string | null): string {
  if (!isAvatarAccentHex(accentHex)) {
    return NOTIFICATION_AVATAR_FALLBACK_DISC_HEX;
  }
  const rgb = parseInt(accentHex.slice(1), 16);
  const mixed = (shift: number) => {
    const channel = (rgb >> shift) & 0xff;
    return Math.round(255 + (channel - 255) * ACCENT_MIX)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${mixed(16)}${mixed(8)}${mixed(0)}`.toUpperCase();
}

/** Raster formats an `<image>` href carries here; what resvg and a canvas both decode. */
export type NotificationAvatarMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif";

/**
 * The three measurements the drawing derives from the edge: the disc's radius,
 * which is also its centre; the free border around the avatar; and the
 * avatar's own edge. Every rasterizer reads them from here, so the daemon's
 * SVG and the desktop canvas cannot drift.
 */
export function notificationAvatarGeometry(
  size: number = NOTIFICATION_AVATAR_SIZE,
): { radius: number; offset: number; inner: number } {
  const offset = size * NOTIFICATION_AVATAR_INSET;
  return { radius: size / 2, offset, inner: size - 2 * offset };
}

export interface NotificationAvatarSvgOptions {
  /** The avatar raster to draw inside the disc, base64 with no data prefix. */
  innerPngBase64: string;
  /** What `innerPngBase64` holds; PNG unless an upload arrived as a JPEG or a GIF. */
  innerMediaType?: NotificationAvatarMediaType;
  accentHex: string | null;
  size?: number;
}

/** Trims the float noise a fractional inset leaves in the coordinates. */
function px(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * The notification avatar as an SVG document: a filled disc with the avatar
 * drawn inset into it.
 *
 * The inner raster is cover-cropped (`xMidYMid slice`), matching what the web
 * canvas does, so a portrait or landscape upload fills the square instead of
 * being letterboxed onto the disc. It is then clipped to the disc, so the disc
 * edge is the hard boundary no matter how far a cover-crop overflows.
 *
 * The `<image href="data:...">` shape is the one `downscaleRaster()` in
 * `assistant/src/platform/sync-avatar.ts` already feeds resvg, so the daemon's
 * rasterizer is known to render it.
 */
export function notificationAvatarSvg({
  innerPngBase64,
  innerMediaType = "image/png",
  accentHex,
  size = NOTIFICATION_AVATAR_SIZE,
}: NotificationAvatarSvgOptions): string {
  const { radius, offset, inner } = notificationAvatarGeometry(size);
  const href = `data:${innerMediaType};base64,${innerPngBase64}`;
  const disc = `cx="${px(radius)}" cy="${px(radius)}" r="${px(radius)}"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${px(size)}" height="${px(size)}" viewBox="0 0 ${px(size)} ${px(size)}">` +
    `<circle ${disc} fill="${notificationAvatarDiscHex(accentHex)}"/>` +
    `<defs><clipPath id="${CLIP_ID}"><circle ${disc}/></clipPath></defs>` +
    `<image x="${px(offset)}" y="${px(offset)}" width="${px(inner)}" height="${px(inner)}" ` +
    `preserveAspectRatio="xMidYMid slice" clip-path="url(#${CLIP_ID})" ` +
    `href="${href}" xlink:href="${href}"/></svg>`
  );
}
