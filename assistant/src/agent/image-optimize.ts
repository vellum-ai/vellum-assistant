import { parseImageDimensions } from "../context/image-dimensions.js";
import { convertImageToJpeg } from "../util/image-conversion.js";

// Anthropic's documented max dimension — images larger than this are scaled
// down server-side anyway, so pre-scaling is zero quality loss.
const MAX_DIMENSION = 1568;

// Threshold below which we skip optimization — small images don't need it.
const OPTIMIZE_THRESHOLD_BYTES = 300 * 1024; // 300 KB

// Anthropic rejects any single image whose source payload exceeds 5 MB,
// regardless of pixel dimensions. Cap at ~3.5 MB raw so the base64-encoded
// form (raw * 4/3) stays comfortably under 5 MB even after re-encoding.
const MAX_TRANSPORT_BYTES = Math.floor(3.5 * 1024 * 1024); // ~3.5 MB raw

const JPEG_QUALITY = 80;

/**
 * Decide whether an image needs to be rescaled before sending.
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
 * Downscale a base64 image to fit within Anthropic's recommended dimensions
 * (1568px max side). Returns the original data unchanged if the image is
 * already small enough or if optimization fails.
 *
 * Anthropic applies the same scaling server-side, so this is zero quality
 * loss — we just do it pre-flight to keep request payloads small and avoid
 * 413 "request too large" errors when many images accumulate in context.
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

  if (!shouldRescaleImage(dims, rawBytes.length)) {
    return { data: base64Data, mediaType };
  }

  const optimized = convertImageToJpeg(rawBytes, {
    maxDimensionPx: MAX_DIMENSION,
    quality: JPEG_QUALITY,
  });
  if (!optimized) {
    return { data: base64Data, mediaType };
  }

  return { data: optimized.toString("base64"), mediaType: "image/jpeg" };
}
