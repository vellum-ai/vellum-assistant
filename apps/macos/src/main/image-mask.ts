/**
 * Pure alpha-mask geometry for the avatar icon surfaces.
 *
 * The macOS Dock and the menu-bar (Tray) present the same assistant avatar
 * clipped to different shapes — the Dock to a rounded square ("squircle") and
 * the Tray to a circle — matching the native app, which clips the avatar with
 * `NSBezierPath(roundedRect:xRadius:)` for the Dock and a circular layer mask
 * for the menu bar (`clients/macos/.../Features/Avatar/AvatarAppearanceManager.swift`).
 *
 * Clipping is expressed as a coverage function: for each pixel center it
 * returns how much of the pixel lies inside the shape, in `[0, 1]`. Edge
 * pixels get fractional coverage so the clip is anti-aliased instead of
 * stair-stepped. `applyAlphaMask` multiplies a bitmap's existing alpha by that
 * coverage, so a fully-inside pixel keeps its alpha, a fully-outside pixel
 * becomes transparent, and a boundary pixel is blended.
 *
 * The coverage functions take signed distance to the shape boundary (negative
 * inside, positive outside) and convert it to coverage with the same
 * half-pixel ramp the status dot uses (`status-icon.ts`), so every
 * anti-aliased edge in the icon pipeline reads identically.
 *
 * Everything here is pure and operates on plain BGRA `Buffer`s — Electron's
 * `nativeImage` bitmap byte order — so the geometry is unit-testable without
 * Electron.
 */

/**
 * Map a signed distance (in pixels) from a shape's boundary to pixel coverage.
 * Negative is inside, positive is outside; the ±0.5px ramp centered on the
 * boundary yields one-pixel-wide anti-aliasing.
 */
const coverageFromSignedDistance = (signedDistance: number): number =>
  Math.min(1, Math.max(0, 0.5 - signedDistance));

/**
 * Coverage for the largest circle inscribed in a `sizePx` square (the Tray
 * clip). Center and radius are half the canvas, so the circle touches all four
 * edges.
 */
export const circleCoverage =
  (sizePx: number): ((x: number, y: number) => number) =>
  (x, y) => {
    const center = sizePx / 2;
    const dx = x + 0.5 - center;
    const dy = y + 0.5 - center;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return coverageFromSignedDistance(distance - sizePx / 2);
  };

/**
 * Coverage for a rounded square filling a `sizePx` canvas with corner radius
 * `radiusPx` (the Dock clip). Uses the standard rounded-box signed-distance
 * field (Quílez, https://iquilezles.org/articles/distfunctions2d/): for a box
 * of half-extents `b` and corner radius `r`,
 *   `sdf = min(max(qx, qy), 0) + length(max(q, 0)) − r`, where `q = |p| − b + r`.
 * `radiusPx` is clamped to half the canvas so an over-large radius degrades to
 * a circle rather than inverting the field.
 */
export const roundedRectCoverage =
  (sizePx: number, radiusPx: number): ((x: number, y: number) => number) =>
  (x, y) => {
    const half = sizePx / 2;
    const r = Math.min(Math.max(radiusPx, 0), half);
    const px = Math.abs(x + 0.5 - half);
    const py = Math.abs(y + 0.5 - half);
    const qx = px - half + r;
    const qy = py - half + r;
    const outside = Math.sqrt(
      Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qy, 0) * Math.max(qy, 0),
    );
    const inside = Math.min(Math.max(qx, qy), 0);
    return coverageFromSignedDistance(outside + inside - r);
  };

/**
 * Multiply each pixel's alpha in a BGRA `bitmap` by `coverage(x, y)`, clipping
 * the image to the shape that coverage describes. Mutates the buffer in place
 * and returns it. Coverage of 1 leaves a pixel untouched; 0 makes it
 * transparent; fractional values at the boundary anti-alias the clip while
 * preserving the pixel's color (only alpha is scaled).
 */
export const applyAlphaMask = (
  bitmap: Buffer,
  sizePx: number,
  coverage: (x: number, y: number) => number,
): Buffer => {
  for (let y = 0; y < sizePx; y++) {
    for (let x = 0; x < sizePx; x++) {
      const c = coverage(x, y);
      if (c >= 1) continue;
      const alphaOffset = (y * sizePx + x) * 4 + 3;
      bitmap[alphaOffset] = Math.round(bitmap[alphaOffset]! * c);
    }
  }
  return bitmap;
};

/**
 * Copy a `srcSizePx`-square BGRA `src` bitmap into the center of a
 * `destSizePx`-square transparent BGRA canvas, returning the new canvas.
 * `src` must be no larger than the destination. Used to inset the clipped
 * avatar inside the Dock icon's transparent padding, matching the native
 * app's icon margin.
 */
export const compositeCentered = (
  src: Buffer,
  srcSizePx: number,
  destSizePx: number,
): Buffer => {
  const dest = Buffer.alloc(destSizePx * destSizePx * 4);
  const offset = Math.round((destSizePx - srcSizePx) / 2);
  for (let y = 0; y < srcSizePx; y++) {
    const destRow = (y + offset) * destSizePx + offset;
    src.copy(dest, destRow * 4, y * srcSizePx * 4, (y + 1) * srcSizePx * 4);
  }
  return dest;
};
