/**
 * The notification avatar: the assistant's avatar centered on an opaque disc
 * tinted by its accent, the icon a native notification shows as the sender.
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
export const NOTIFICATION_AVATAR_ACCENT_MIX = 0.14;

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
    return Math.round(255 + (channel - 255) * NOTIFICATION_AVATAR_ACCENT_MIX)
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
  const offset = size * NOTIFICATION_AVATAR_INSET;
  const inner = size - 2 * offset;
  const radius = size / 2;
  const href = `data:${innerMediaType};base64,${innerPngBase64}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${px(size)}" height="${px(size)}" viewBox="0 0 ${px(size)} ${px(size)}">` +
    `<circle cx="${px(radius)}" cy="${px(radius)}" r="${px(radius)}" fill="${notificationAvatarDiscHex(accentHex)}"/>` +
    `<image x="${px(offset)}" y="${px(offset)}" width="${px(inner)}" height="${px(inner)}" ` +
    `href="${href}" xlink:href="${href}"/></svg>`
  );
}
