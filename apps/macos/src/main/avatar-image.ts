import { nativeImage } from "electron";

import { getAvatarPng } from "./avatar";

/**
 * Decode the cached avatar PNG and resize it to a `sizePx` square BGRA bitmap,
 * the shared first step both icon surfaces need before clipping (the Dock to a
 * rounded square, the Tray to a circle). Returns `null` when there is no
 * avatar or the bytes can't be decoded, so callers fall back to the bundled
 * Vellum mark.
 *
 * Kept separate from the per-surface masking so the decode/resize lives in one
 * place; the renderer always publishes a square PNG, so a plain resize never
 * distorts the avatar.
 */
export const avatarBitmap = (sizePx: number): Buffer | null => {
  const png = getAvatarPng();
  if (!png) return null;

  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) return null;

  return image
    .resize({ width: sizePx, height: sizePx, quality: "best" })
    .toBitmap();
};
