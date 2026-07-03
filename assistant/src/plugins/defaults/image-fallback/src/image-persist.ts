/**
 * Persist image data to the workspace attachments directory.
 *
 * When the active model is text-only, the image-fallback plugin captions the
 * image and substitutes a text block. Saving the raw image to a known,
 * content-hash-deduped location means the original survives the text
 * substitution and stays findable on disk for the user (or a subagent with a
 * vision-capable model that reads it via file_read).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { imageHash } from "./caption-cache.js";

/** The workspace attachments directory. */
const ATTACHMENTS_DIR = "/workspace/data/attachments";

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
 * Returns the absolute file path, or `null` when the write fails.
 */
export function persistImage(data: string, mediaType: string): string | null {
  try {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });

    const hash = imageHash(data);
    const ext = extensionForMediaType(mediaType);
    const filename = `${hash}${ext}`;
    const filepath = join(ATTACHMENTS_DIR, filename);

    // Skip if already saved (content-hash dedup).
    if (existsSync(filepath)) return filepath;

    writeFileSync(filepath, Buffer.from(data, "base64"));
    return filepath;
  } catch {
    return null;
  }
}
