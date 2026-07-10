import { parseImageDimensions } from "../context/image-dimensions.js";
import { convertImageToJpeg } from "../util/image-conversion.js";

// Anthropic's documented max dimension — images larger than this are scaled
// down server-side anyway, so pre-scaling is zero quality loss.
const MAX_DIMENSION = 1568;

// Minimum per-side pixel floor. Anthropic rejects very small images with a
// 400 "Could not process image" (observed with a 16×14 px upload); the exact
// floor is undocumented, so this sits comfortably above the model's 28-px
// visual-patch size. Upscaling adds no information, so raising a tiny image
// to this floor is lossless — it only makes the payload acceptable.
// Exported so the image-recovery plugin gates on the same floor.
export const MIN_IMAGE_DIMENSION = 64;

// Threshold below which we skip optimization — small images don't need it.
const OPTIMIZE_THRESHOLD_BYTES = 300 * 1024; // 300 KB

// Anthropic rejects any single image whose source payload exceeds 5 MB,
// regardless of pixel dimensions. Cap at ~3.5 MB raw so the base64-encoded
// form (raw * 4/3) stays comfortably under 5 MB even after re-encoding.
const MAX_TRANSPORT_BYTES = Math.floor(3.5 * 1024 * 1024); // ~3.5 MB raw

const JPEG_QUALITY = 80;

/**
 * Decide whether an image needs to be rescaled (downscaled) before sending.
 *
 * Two independent gates apply:
 *   1. Pixel dimensions — Anthropic rejects many-image requests when any
 *      image exceeds 2000 px on a side. A sparse screenshot can be under
 *      300 KB while still being 3000+ px wide.
 *   2. Byte size — Anthropic rejects any image whose source payload
 *      exceeds 5 MB. A 1500×1500 high-color screenshot can produce a >5 MB
 *      payload while staying well under the dimension cap.
 *
 * Exported for unit testing.
 */
export function shouldRescaleImage(
  dims: { width: number; height: number } | null,
  byteLength: number,
): boolean {
  if (byteLength > MAX_TRANSPORT_BYTES) return true;
  if (dims) {
    return dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION;
  }
  // Dimensions unparseable — fall back to file size as a rough proxy.
  return byteLength > OPTIMIZE_THRESHOLD_BYTES;
}

/**
 * Whether an image sits below the provider's minimum-size floor on either
 * side and needs upscaling before sending. Requires parsed dimensions — a
 * byte-size proxy cannot distinguish a tiny image from a well-compressed
 * large one.
 *
 * Exported for unit testing and for the image-recovery plugin's gate.
 */
export function isBelowMinDimension(
  dims: { width: number; height: number } | null,
): boolean {
  return (
    dims != null &&
    (dims.width < MIN_IMAGE_DIMENSION || dims.height < MIN_IMAGE_DIMENSION)
  );
}

/**
 * Aspect-preserving target dimensions that lift an undersized image's short
 * side to {@link MIN_IMAGE_DIMENSION}. The scale factor is capped so the long
 * side never exceeds {@link MAX_DIMENSION}; for pathological aspect ratios
 * where no upscale is possible under that cap, returns null and the caller
 * keeps the original bytes (the recovery path then notes the image out).
 *
 * Exported for unit testing.
 */
export function upscaleTargetDimensions(dims: {
  width: number;
  height: number;
}): { width: number; height: number } | null {
  const shortSide = Math.min(dims.width, dims.height);
  const longSide = Math.max(dims.width, dims.height);
  if (shortSide <= 0) return null;
  const scale = Math.min(
    MIN_IMAGE_DIMENSION / shortSide,
    MAX_DIMENSION / longSide,
  );
  if (scale <= 1) return null;
  return {
    width: Math.max(1, Math.round(dims.width * scale)),
    height: Math.max(1, Math.round(dims.height * scale)),
  };
}

/**
 * Rescale a base64 image to fit within Anthropic's size limits: downscale to
 * the recommended 1568px max side, or upscale an undersized image to the
 * {@link MIN_IMAGE_DIMENSION} floor. Returns the original data unchanged if
 * the image is already within limits or if conversion fails.
 *
 * Downscaling matches what Anthropic applies server-side, so it is zero
 * quality loss — done pre-flight to keep request payloads small and avoid
 * 413 "request too large" errors when many images accumulate in context.
 * Upscaling adds no information but keeps tiny images (icons, favicons)
 * above the provider's rejection floor.
 *
 * Conversion (and its content-addressed disk cache) is shared with attachment
 * storage normalization — see `util/image-conversion.ts`.
 */
export function optimizeImageForTransport(
  base64Data: string,
  mediaType: string,
): { data: string; mediaType: string } {
  const rawBytes = Buffer.from(base64Data, "base64");
  const dims = parseImageDimensions(base64Data, mediaType);

  // The downscale gates win when both apply (an extreme-aspect image can be
  // simultaneously over the long-side cap and under the short-side floor):
  // an oversized payload is the more common hard rejection.
  if (shouldRescaleImage(dims, rawBytes.length)) {
    const optimized = convertImageToJpeg(rawBytes, {
      maxDimensionPx: MAX_DIMENSION,
      quality: JPEG_QUALITY,
    });
    if (!optimized) {
      return { data: base64Data, mediaType };
    }
    return { data: optimized.toString("base64"), mediaType: "image/jpeg" };
  }

  if (isBelowMinDimension(dims)) {
    const target = dims ? upscaleTargetDimensions(dims) : null;
    const upscaled = target
      ? convertImageToJpeg(rawBytes, {
          resizeToPx: target,
          quality: JPEG_QUALITY,
        })
      : null;
    if (upscaled) {
      return { data: upscaled.toString("base64"), mediaType: "image/jpeg" };
    }
  }

  return { data: base64Data, mediaType };
}
