import { nativeImage, systemPreferences, type NativeImage } from "electron";

import {
  MENU_BAR_GLYPH_PNG_2X_BASE64,
  MENU_BAR_GLYPH_PNG_1X_BASE64,
} from "./assets/menu-bar-glyph";
import { avatarBitmap } from "./avatar-image";
import { applyAlphaMask, circleCoverage } from "./image-mask";
import {
  PULSE_FRAME_COUNT,
  pulseOpacityFrames,
  shouldPulse,
  type AssistantStatus,
} from "./status";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

// Each status maps to the macOS system color the native app's dot uses
// (`AssistantStatus.statusColor`: systemGray/Green/Red/Orange/Yellow).
const STATUS_SYSTEM_COLOR: Record<
  AssistantStatus,
  "gray" | "green" | "red" | "orange" | "yellow"
> = {
  idle: "gray",
  thinking: "green",
  error: "red",
  disconnected: "orange",
  authFailed: "yellow",
};

// Apple's published sRGB components for those system colors, used only when
// `getSystemColor` is unavailable (before app-ready, a non-macOS host, or a
// parse miss). The live system color is preferred; these keep the dot sensible
// as a fallback.
// https://developer.apple.com/design/human-interface-guidelines/color#System-colors
const STATUS_FALLBACK_COLOR: Record<AssistantStatus, Rgb> = {
  idle: { r: 142, g: 142, b: 147 },
  thinking: { r: 52, g: 199, b: 89 },
  error: { r: 255, g: 59, b: 48 },
  disconnected: { r: 255, g: 149, b: 0 },
  authFailed: { r: 255, g: 204, b: 0 },
};

// Parse `#RRGGBBAA` / `#RRGGBB` into RGB, or null on mismatch. Any alpha is
// dropped — the dot's opacity is driven by the pulse, not the color.
const parseHexRgb = (hex: string): Rgb | null => {
  const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
  if (!match) return null;
  const n = parseInt(match[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
};

/**
 * Resolve the dot color for `status`, preferring the live macOS system color
 * (appearance- and accessibility-aware, matching the native `NSColor.system*`
 * dynamic colors) and falling back to Apple's sRGB component values when
 * `getSystemColor` is unavailable.
 * https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesgetsystemcolorcolor-macos
 */
export const statusColor = (status: AssistantStatus): Rgb => {
  try {
    const hex = systemPreferences.getSystemColor(STATUS_SYSTEM_COLOR[status]);
    const rgb = parseHexRgb(hex);
    if (rgb) return rgb;
  } catch {
    // getSystemColor is macOS-only and throws before app-ready; fall through.
  }
  return STATUS_FALLBACK_COLOR[status];
};

/**
 * Menu-bar (Tray) icon composition: the assistant avatar (clipped to a
 * circle), or the Vellum brand glyph when no avatar is set, with a colored
 * status dot baked into the bottom-right corner.
 *
 * The Swift app renders this as two layers — an 18pt avatar/glyph plus a 6pt
 * `CAShapeLayer` dot with a 0.5-alpha dark outline ring, pulsing the dot's
 * opacity while thinking
 * (`clients/macos/.../AppDelegate+MenuBar.swift`). Electron's `Tray` takes a
 * single flattened `NativeImage` with no sublayers, so the dot is composited
 * into the bitmap here and the pulse is a set of pre-rendered frames at
 * descending dot opacity.
 *
 * Geometry is kept in the same points as the Swift app and rendered at 2x so
 * Retina menu bars get a crisp dot; the resulting image is tagged
 * `scaleFactor: 2` and macOS downsamples for non-Retina displays.
 *
 * The image is **not** a template image. macOS auto-inverts template images
 * for dark menu bars and the menu-open pressed state, but a template image is
 * masked to a single color and cannot carry the colored status dot (or a
 * full-color avatar). Colored menu-bar icons are explicitly supported — they
 * just opt out of templating
 * (https://www.electronjs.org/docs/latest/api/native-image#template-image-macos),
 * matching the Swift app, which also sets `isTemplate = false` for the
 * colored avatar.
 */

const ICON_POINTS = 18;
const SCALE = 2;
const CANVAS_PX = ICON_POINTS * SCALE; // 36
const DOT_DIAMETER_PX = 6 * SCALE; // 12
const RING_WIDTH_PX = SCALE; // 2 (1pt)
const DOT_MARGIN_PX = SCALE; // 2 (1pt inset from the edges)
// Dark outline ring around the dot so it reads against both the glyph and a
// dark menu bar — the Swift app strokes the dot with `auxBlack` at 0.5 alpha.
const RING_COLOR: Rgb = { r: 0, g: 0, b: 0 };
const RING_ALPHA = 0.5;

/**
 * Alpha-blend a single `src` color (premultiplied by `coverage`) over a BGRA
 * pixel in `bitmap` at `offset`, in place. Standard source-over compositing:
 * `out = src·a + dst·(1 − a)`. Electron's `nativeImage.toBitmap()` /
 * `createFromBitmap()` use BGRA byte order on all platforms.
 */
const blendPixel = (
  bitmap: Buffer,
  offset: number,
  color: Rgb,
  coverage: number,
): void => {
  if (coverage <= 0) return;
  const a = Math.min(1, Math.max(0, coverage));
  bitmap[offset + 0] = Math.round(color.b * a + bitmap[offset + 0]! * (1 - a));
  bitmap[offset + 1] = Math.round(color.g * a + bitmap[offset + 1]! * (1 - a));
  bitmap[offset + 2] = Math.round(color.r * a + bitmap[offset + 2]! * (1 - a));
  bitmap[offset + 3] = Math.round(255 * a + bitmap[offset + 3]! * (1 - a));
};

/**
 * Composite an anti-aliased status dot (filled disk + dark outline ring) into
 * the bottom-right corner of a BGRA `bitmap`, mutating it in place and
 * returning it. `opacity` fades the whole dot — fill and ring together — to
 * drive the pulse, matching the Swift app animating the dot layer's opacity.
 *
 * Pure aside from the in-place mutation of the passed buffer, so the geometry
 * and blending are unit-testable on a synthetic bitmap without Electron.
 */
export const compositeStatusDot = (
  bitmap: Buffer,
  sizePx: number,
  color: Rgb,
  opacity: number,
): Buffer => {
  const radius = DOT_DIAMETER_PX / 2;
  const innerEdge = radius - RING_WIDTH_PX;
  const center = sizePx - DOT_MARGIN_PX - radius;

  for (let y = 0; y < sizePx; y++) {
    for (let x = 0; x < sizePx; x++) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Outer AA edge of the whole dot, and the inner filled disk. The ring
      // is the annulus between them.
      const outerCoverage = Math.min(1, Math.max(0, radius - dist + 0.5));
      if (outerCoverage <= 0) continue;
      const fillCoverage = Math.min(1, Math.max(0, innerEdge - dist + 0.5));
      const ringCoverage = Math.max(0, outerCoverage - fillCoverage);

      const offset = (y * sizePx + x) * 4;
      // Ring first (sits under the fill's AA seam), then the colored fill.
      blendPixel(bitmap, offset, RING_COLOR, ringCoverage * RING_ALPHA * opacity);
      blendPixel(bitmap, offset, color, fillCoverage * opacity);
    }
  }
  return bitmap;
};

let cachedGlyphBitmap: Buffer | null = null;

/**
 * Decode the embedded brand glyph and resize it to the icon canvas once,
 * caching the BGRA bitmap so each composited frame starts from a fresh copy
 * without re-decoding the PNG. Prefers the 2x asset for the 36px canvas;
 * falls back to the 1x asset if the 2x rendition is unavailable.
 */
const glyphBitmap = (): Buffer => {
  if (cachedGlyphBitmap) return Buffer.from(cachedGlyphBitmap);
  const source =
    MENU_BAR_GLYPH_PNG_2X_BASE64.length > 0
      ? MENU_BAR_GLYPH_PNG_2X_BASE64
      : MENU_BAR_GLYPH_PNG_1X_BASE64;
  const glyph = nativeImage
    .createFromBuffer(Buffer.from(source, "base64"))
    .resize({ width: CANVAS_PX, height: CANVAS_PX, quality: "best" });
  cachedGlyphBitmap = glyph.toBitmap();
  return Buffer.from(cachedGlyphBitmap);
};

let cachedAvatarBase: Buffer | null = null;
let avatarBaseResolved = false;

/**
 * The base bitmap the status dot is composited onto: the assistant avatar
 * clipped to a circle when one has been published, otherwise the bundled
 * brand glyph — mirroring the native menu bar (`customAvatarImage ??
 * fullAvatarImage`, with the brand mark as the no-avatar fallback). The
 * decoded-and-masked avatar is cached and invalidated through
 * `invalidateIconCache` so the per-frame pulse doesn't re-decode the PNG.
 * Returns a fresh copy so callers can mutate it in place.
 */
const baseBitmap = (): Buffer => {
  if (!avatarBaseResolved) {
    const avatar = avatarBitmap(CANVAS_PX);
    cachedAvatarBase = avatar
      ? applyAlphaMask(avatar, CANVAS_PX, circleCoverage(CANVAS_PX))
      : null;
    avatarBaseResolved = true;
  }
  return cachedAvatarBase ? Buffer.from(cachedAvatarBase) : glyphBitmap();
};

/**
 * Build the Tray image for `status` at dot `opacity` (1 = solid; lower =
 * mid-pulse). Composites a fresh copy of the base bitmap (circular avatar or
 * brand-glyph fallback) with the status dot and tags the result as a 2x
 * non-template image.
 */
export const buildStatusIcon = (
  status: AssistantStatus,
  opacity = 1,
): NativeImage => {
  const bitmap = baseBitmap();
  compositeStatusDot(bitmap, CANVAS_PX, statusColor(status), opacity);
  const image = nativeImage.createFromBitmap(bitmap, {
    width: CANVAS_PX,
    height: CANVAS_PX,
    scaleFactor: SCALE,
  });
  image.setTemplateImage(false);
  return image;
};

/**
 * Pre-render every frame a status needs: a single solid frame for the static
 * states, and the full descending-then-rising opacity cycle for `thinking`.
 * Cached per status so the pulse timer swaps among ready `NativeImage`s with
 * no per-tick allocation.
 */
const frameCache = new Map<AssistantStatus, NativeImage[]>();

export const statusFrames = (status: AssistantStatus): NativeImage[] => {
  const cached = frameCache.get(status);
  if (cached) return cached;
  const frames = shouldPulse(status)
    ? pulseOpacityFrames(PULSE_FRAME_COUNT).map((opacity) =>
        buildStatusIcon(status, opacity),
      )
    : [buildStatusIcon(status, 1)];
  frameCache.set(status, frames);
  return frames;
};

/**
 * Drop the cached avatar base and pre-rendered frames so the next
 * `statusFrames` rebuilds from current inputs. Called when the avatar changes
 * (new base image) or the system appearance changes (the live `getSystemColor`
 * dot color shifts for Dark Mode / accessibility settings). The static brand
 * glyph never changes, so its cache is left intact.
 */
export const invalidateIconCache = (): void => {
  avatarBaseResolved = false;
  cachedAvatarBase = null;
  frameCache.clear();
};

// Test seam — clears every memoized bitmap/frame cache so a test that stubs
// `nativeImage` or the avatar differently isn't served a stale image.
export const __resetForTesting = (): void => {
  cachedGlyphBitmap = null;
  invalidateIconCache();
};
