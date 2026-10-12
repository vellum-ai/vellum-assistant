/**
 * Size hints for a stored image reference, computed from the bytes the store
 * holds.
 *
 * The model receives the transport-optimized image (`resolveMediaReferences`
 * applies the same optimization at send time), so a reference hints the
 * optimized dimensions and byte length rather than the stored original's; the
 * per-turn token estimate and the payload cap then stay accurate without a
 * disk read on the hot path. The hints come from the stored bytes, never from
 * the payload a writer had in hand: storage normalization may rewrite the
 * bytes (HEIF to JPEG) without changing the declared type, so the payload is
 * not a reliable stand-in for what the send path will read back.
 */

import { optimizeImageForTransport } from "../agent/image-optimize.js";
import { parseImageDimensions } from "../context/image-dimensions.js";
import { getAttachmentContent } from "../persistence/attachments-store.js";

export interface StoredImageReferenceHints {
  dimensions: { width: number; height: number } | null;
  /** Decoded byte length of the transport-optimized image. */
  transportSizeBytes: number;
}

/** Null when the stored bytes cannot be read; callers then record no hints. */
export async function storedImageReferenceHints(
  attachmentId: string,
  mediaType: string,
): Promise<StoredImageReferenceHints | null> {
  const bytes = getAttachmentContent(attachmentId);
  if (!bytes) {
    return null;
  }
  const optimized = await optimizeImageForTransport(
    bytes.toString("base64"),
    mediaType,
  );
  return {
    dimensions: parseImageDimensions(optimized.data, optimized.mediaType),
    transportSizeBytes: Buffer.byteLength(optimized.data, "base64"),
  };
}
