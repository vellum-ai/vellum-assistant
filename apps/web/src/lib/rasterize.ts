/**
 * Rasterize avatar art to a PNG data URL via an offscreen canvas.
 *
 * The Electron main process turns the result into a `nativeImage` for the
 * macOS Dock icon. `nativeImage` can't render SVG, and the renderer's blob
 * URLs aren't reachable from main, so the renderer pre-rasterizes here and
 * hands main a self-contained PNG.
 *
 * Both helpers resolve to `null` on any failure (no 2D context, source fails
 * to load, tainted canvas) so callers fall back to the default icon rather
 * than crash.
 */

/** Rasterize `<svg>` markup to a square PNG data URL at `size`×`size`. */
export async function rasterizeSvgToPng(
  svg: string,
  size: number,
): Promise<string | null> {
  return rasterizeSource(`data:image/svg+xml,${encodeURIComponent(svg)}`, size);
}

/**
 * Rasterize any loadable image source (blob URL, data URL, same-origin URL)
 * to a square PNG data URL at `size`×`size`.
 */
export async function rasterizeImageToPng(
  src: string,
  size: number,
): Promise<string | null> {
  return rasterizeSource(src, size);
}

async function rasterizeSource(
  src: string,
  size: number,
): Promise<string | null> {
  let image: HTMLImageElement;
  try {
    image = await loadImage(src);
  } catch {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  try {
    ctx.drawImage(image, 0, 0, size, size);
    return canvas.toDataURL("image/png");
  } catch {
    // toDataURL throws on a tainted canvas. Our sources are same-origin, but
    // guard anyway so a surprise cross-origin source degrades gracefully.
    return null;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image load failed"));
    image.src = src;
  });
}
