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

import {
  NOTIFICATION_AVATAR_SIZE,
  notificationAvatarDiscHex,
  notificationAvatarGeometry,
} from "@vellumai/avatar-manifest/notification-avatar";

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
 * Decode `src`, an SVG data URI or a renderer-owned blob URL. Rejects when the
 * source cannot be loaded.
 */
async function loadImage(src: string): Promise<HTMLImageElement> {
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
  return image;
}

/**
 * Draw the source's centered square crop (see {@link coverCropSquare}) into
 * the `size`×`size` box at `x`,`y`, so a portrait or logo renders identically
 * instead of being stretched. Draws nothing for a degenerate source.
 *
 * `naturalWidth/Height` is the decoded pixel size; SVG sources fall back to
 * `width/height`.
 */
function drawCoverSquare(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  size: number,
): void {
  const crop = coverCropSquare(
    image.naturalWidth || image.width,
    image.naturalHeight || image.height,
  );
  if (!crop) {
    return;
  }
  ctx.drawImage(
    image,
    crop.sx,
    crop.sy,
    crop.side,
    crop.side,
    x,
    y,
    size,
    size,
  );
}

/**
 * A transparent `size`×`size` canvas and its 2D context, or null when the
 * browser hands back no context so the caller can fall back.
 */
function createSquareCanvas(
  size: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.clearRect(0, 0, size, size);
  return { canvas, ctx };
}

/** Encode the canvas, or null when the browser hands back no blob. */
async function encodeCanvas(
  canvas: HTMLCanvasElement,
  type: "image/png" | "image/jpeg",
  quality?: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
  if (!blob) {
    return null;
  }
  return new Uint8Array(await blob.arrayBuffer());
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
  const image = await loadImage(src);

  const surface = createSquareCanvas(size);
  if (!surface) {
    return null;
  }
  const { canvas, ctx } = surface;

  // JPEG has no alpha, so an un-backed transparent avatar would flatten to
  // black. White matches the light-surface treatment the avatar is designed
  // against, and only applies on the JPEG fallback path.
  if (type === "image/jpeg") {
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, size, size);
  }

  drawCoverSquare(ctx, image, 0, 0, size);

  return encodeCanvas(canvas, type, quality);
}

/**
 * Draw the notification avatar: the avatar inset into an opaque disc tinted by
 * its accent, the icon a native notification shows as the sender. Returns null
 * when the canvas or the encoder gives nothing back, so the caller sends no
 * sender rather than a broken one.
 *
 * The geometry and the disc colour come from
 * `@vellumai/avatar-manifest/notification-avatar`, the same spec the daemon
 * rasterizes with resvg, so the picture is one picture on every platform.
 */
export async function rasterizeNotificationAvatar(
  src: string,
  accentHex: string | null,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const image = await loadImage(src);
  const size = NOTIFICATION_AVATAR_SIZE;

  const surface = createSquareCanvas(size);
  if (!surface) {
    return null;
  }
  const { canvas, ctx } = surface;

  const { radius, offset, inner } = notificationAvatarGeometry(size);
  const discPath = (): void => {
    ctx.beginPath();
    ctx.arc(radius, radius, radius, 0, Math.PI * 2);
  };

  discPath();
  ctx.fillStyle = notificationAvatarDiscHex(accentHex);
  ctx.fill();

  // The avatar goes through the same disc, the one the SVG is clipped to, so a
  // source whose subject runs to its own edges keeps the round silhouette
  // instead of painting square corners over the fill.
  ctx.save();
  discPath();
  ctx.clip();
  drawCoverSquare(ctx, image, offset, offset, inner);
  ctx.restore();

  return encodeCanvas(canvas, "image/png");
}
