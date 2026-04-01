import { readFileSync, statSync } from "node:fs";

import { optimizeImageForTransport } from "../../../agent/image-optimize.js";
import type { ImageContent } from "../../../providers/types.js";
import type { ToolExecutionResult } from "../../types.js";

export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
]);

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB — LLM API transport limit (post-optimization)
const MAX_SOURCE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB — pre-optimization guard

/**
 * Detect the actual image format from the first bytes of the buffer.
 * Returns the MIME type, or null if unrecognised.
 */
function detectMediaType(buf: Buffer): string | null {
  if (buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  // GIF: 47 49 46 38
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  ) {
    return "image/gif";
  }
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

/**
 * Read an image file from disk, optionally optimize it, and return a
 * ToolExecutionResult with base64-encoded image content blocks.
 *
 * The caller is responsible for path resolution and sandbox enforcement -
 * `resolvedPath` must be an already-validated absolute path.
 */
export function readImageFile(resolvedPath: string): ToolExecutionResult {
  let stat;
  try {
    stat = statSync(resolvedPath);
  } catch {
    return {
      content: `Error: file not found: ${resolvedPath}`,
      isError: true,
    };
  }

  if (!stat.isFile()) {
    return { content: `Error: ${resolvedPath} is not a file`, isError: true };
  }

  if (stat.size > MAX_SOURCE_SIZE_BYTES) {
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    return {
      content: `Error: image too large (${sizeMB} MB). Maximum source file size is 100 MB.`,
      isError: true,
    };
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(resolvedPath) as Buffer;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error reading file: ${msg}`, isError: true };
  }

  if (buffer.length > MAX_SIZE_BYTES) {
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    return {
      content: `Error: image too large (${sizeMB} MB). Maximum is 20 MB.`,
      isError: true,
    };
  }

  // Detect actual format from magic bytes - never trust the file extension
  // alone, since sips converts to JPEG and files can be misnamed.
  const detectedType = detectMediaType(buffer);
  if (!detectedType) {
    return {
      content: `Error: could not detect image format for ${resolvedPath}. The file may be corrupt.`,
      isError: true,
    };
  }

  const rawBase64 = buffer.toString("base64");
  const { data: base64Data, mediaType: finalType } =
    optimizeImageForTransport(rawBase64, detectedType);
  const optimized = base64Data !== rawBase64;

  const imageBlock: ImageContent = {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: finalType,
      data: base64Data,
    },
  };

  const optimizedBytes = optimized
    ? Math.ceil((base64Data.length * 3) / 4)
    : buffer.length;
  const sizeSuffix = optimized
    ? ` (optimized from ${(stat.size / 1024).toFixed(0)} KB to ${(
        optimizedBytes / 1024
      ).toFixed(0)} KB)`
    : "";

  return {
    content: `Image loaded: ${resolvedPath} (${optimizedBytes} bytes, ${finalType})${sizeSuffix}`,
    isError: false,
    contentBlocks: [imageBlock],
  };
}
