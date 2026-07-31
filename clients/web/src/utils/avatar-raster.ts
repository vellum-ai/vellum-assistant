/**
 * Rasterizing the assistant avatar to pixels, for the surfaces that cannot
 * consume the trait-composited SVG directly.
 *
 * Two consumers, for different reasons. The Electron Dock/Tray icons need PNG
 * because `nativeImage` decodes only PNG/JPEG. The iOS Live Activity needs
 * bytes because a widget renders from a snapshot: there is no async image
 * loading in a Live Activity view, so an avatar has to arrive already decoded
 * rather than as a URL the extension could fetch.
 *
 * Source precedence (character SVG, then custom image, then none) is not
 * decided here. It comes from `resolveAvatarRender`, so every avatar surface
 * agrees on which avatar it is drawing.
 */

/**
 * The largest centered square of a `srcW`×`srcH` source, the source rect for
 * an `object-cover` draw, matching the in-app `ChatAvatar` so non-square
 * uploads render identically on the icon surfaces instead of being stretched.
 * Returns null for a degenerate (zero-dimension) source so the caller draws
 * nothing rather than throwing.
 */
export function coverCropSquare(
  srcW: number,
  srcH: number,
): { sx: number; sy: number; side: number } | null {
  if (srcW <= 0 || srcH <= 0) {
    return null;
  }
  const side = Math.min(srcW, srcH);
  return { sx: (srcW - side) / 2, sy: (srcH - side) / 2, side };
}

/**
 * Draw `src` (an SVG data URI or a renderer-owned blob URL) onto an offscreen
 * canvas at `size`×`size` and return the encoded bytes. Returns null if the
 * image can't be drawn so the caller can fall back.
 *
 * Non-square sources are center-cropped to a square before scaling (see
 * {@link coverCropSquare}) so a portrait or logo renders identically instead
 * of being stretched to fill the square canvas.
 *
 * `type`/`quality` are passed through to `canvas.toBlob`. PNG keeps the
 * transparency a character avatar is composited with; JPEG is smaller for
 * photographic uploads but flattens alpha, so it is only worth reaching for
 * under a byte budget.
 */
export async function rasterizeAvatar(
  src: string,
  size: number,
  type: "image/png" | "image/jpeg" = "image/png",
  quality?: number,
): Promise<Uint8Array | null> {
  const image = new Image();
  image.decoding = "async";
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => {
      resolve();
    };
    image.onerror = () => {
      reject(new Error("avatar image failed to load"));
    };
  });
  image.src = src;
  await loaded;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.clearRect(0, 0, size, size);

  // JPEG has no alpha, so an un-backed transparent avatar would flatten to
  // black. White matches the light-surface treatment the avatar is designed
  // against, and only applies on the JPEG fallback path.
  if (type === "image/jpeg") {
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, size, size);
  }

  // `naturalWidth/Height` is the decoded pixel size (SVG sources fall back to
  // `width/height`, which equal `size` here). Scale the centered square crop
  // to fill the canvas, preserving aspect ratio.
  const crop = coverCropSquare(
    image.naturalWidth || image.width,
    image.naturalHeight || image.height,
  );
  if (crop) {
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
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
  if (!blob) {
    return null;
  }
  return new Uint8Array(await blob.arrayBuffer());
}
