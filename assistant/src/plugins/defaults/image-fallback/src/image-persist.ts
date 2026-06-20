/**
 * Persist image data to the workspace attachments directory.
 *
 * When the active model is text-only, the image-fallback plugin captions the
 * image and substitutes a text block. Saving the raw image to disk and
 * referencing the path in the caption text means a future turn with a
 * vision-capable model (or a subagent) could still access the original image
 * via file_read, and the user can find the image at a known location.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAttachmentsDir } from "../hooks/init.js";
import { imageHash } from "./caption-cache.js";

/** File extension for a given media type, falling back to `.bin`. */
function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
}

/**
 * Save an image's base64 data to the attachments dir if not already present.
 * Returns the absolute file path, or `null` when the attachments dir is not
 * available (init hasn't run) or the write fails.
 */
export function persistImage(
  data: string,
  mediaType: string,
): string | null {
  const dir = getAttachmentsDir();
  if (dir == null) return null;

  const hash = imageHash(data);
  const ext = extensionForMediaType(mediaType);
  const filename = `${hash}${ext}`;
  const filepath = join(dir, filename);

  // Skip if already saved (content-hash dedup).
  if (existsSync(filepath)) return filepath;

  try {
    writeFileSync(filepath, Buffer.from(data, "base64"));
    return filepath;
  } catch {
    return null;
  }
}
