/**
 * Size hints for a stored image reference, computed from the bytes the store
 * holds.
 *
 * The model receives the transport-optimized image (`resolveMediaReferences`
 * applies the same optimization at send time), so a reference hints the
 * optimized dimensions and byte length rather than the stored original's; the
 * per-turn token estimate and the payload cap then stay accurate without a
 * disk read on the hot path. The hints come from the stored bytes, never from
 * the payload a writer had in hand or from the declared type: storage
 * normalization may rewrite the bytes (HEIF to JPEG) without changing the
 * type, and it leaves a type it cannot verify as declared, so neither is a
 * reliable stand-in for what the send path will read back and sniff.
 */

import { optimizeImageForTransport } from "../agent/image-optimize.js";
import { parseImageDimensions } from "../context/image-dimensions.js";
import { getAttachmentContent } from "../persistence/attachments-store.js";
import { isProviderReadableImageData } from "../util/image-conversion.js";

export interface StoredImageReferenceHints {
  dimensions: { width: number; height: number } | null;
  /**
   * Decoded byte length of what the send path puts on the wire: the
   * transport-optimized image, or 0 when the stored bytes are a format no
   * provider reads and the resolver substitutes a text note instead.
   */
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
  const dataBase64 = bytes.toString("base64");
  if (!isProviderReadableImageData(dataBase64)) {
    return { dimensions: null, transportSizeBytes: 0 };
  }
  const optimized = await optimizeImageForTransport(dataBase64, mediaType);
  return {
    dimensions: parseImageDimensions(optimized.data, optimized.mediaType),
    transportSizeBytes: Buffer.byteLength(optimized.data, "base64"),
  };
}
