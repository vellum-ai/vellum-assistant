import { execFileSync } from "node:child_process";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImageContent } from "../../../providers/types.js";
import type { ToolExecutionResult } from "../../types.js";

export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
]);

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

// Images above this threshold get auto-optimized via sips (macOS) to avoid
// sending multi-MB base64 payloads to the LLM API.
const OPTIMIZE_THRESHOLD_BYTES = 1 * 1024 * 1024; // 1 MB
const OPTIMIZE_MAX_DIMENSION = 1568; // Anthropic's recommended max
const OPTIMIZE_JPEG_QUALITY = 80;

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
 * Use macOS `sips` to resize and convert an image to JPEG.
 * Returns the path to the optimized temp file, or null if sips is unavailable.
 */
function optimizeWithSips(srcPath: string): string | null {
  const tmpPath = join(tmpdir(), `vellum-view-image-${Date.now()}.jpg`);
  try {
    execFileSync(
      "sips",
      [
        "--resampleHeightWidthMax",
        String(OPTIMIZE_MAX_DIMENSION),
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(OPTIMIZE_JPEG_QUALITY),
        srcPath,
        "--out",
        tmpPath,
      ],
      { stdio: "pipe", timeout: 15_000 },
    );
    return tmpPath;
  } catch {
    return null;
  }
}

/**
 * Read an image file from disk, optionally optimize it, and return a
 * ToolExecutionResult with base64-encoded image content blocks.
 *
 * The caller is responsible for path resolution and sandbox enforcement —
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

  if (stat.size > MAX_SIZE_BYTES) {
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    return {
      content: `Error: image too large (${sizeMB} MB). Maximum is 20 MB.`,
      isError: true,
    };
  }

  let buffer: Buffer;
  let optimized = false;
  let tmpPath: string | null = null;

  try {
    if (stat.size > OPTIMIZE_THRESHOLD_BYTES) {
      tmpPath = optimizeWithSips(resolvedPath);
      if (tmpPath) {
        buffer = readFileSync(tmpPath) as Buffer;
        optimized = true;
      } else {
        buffer = readFileSync(resolvedPath) as Buffer;
      }
    } else {
      buffer = readFileSync(resolvedPath) as Buffer;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error reading file: ${msg}`, isError: true };
  } finally {
    if (tmpPath) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore cleanup errors */
      }
    }
  }

  // Detect actual format from magic bytes — never trust the file extension
  // alone, since sips converts to JPEG and files can be misnamed.
  const detectedType = detectMediaType(buffer);
  if (!detectedType) {
    return {
      content: `Error: could not detect image format for ${resolvedPath}. The file may be corrupt.`,
      isError: true,
    };
  }

  const base64Data = buffer.toString("base64");

  const imageBlock: ImageContent = {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: detectedType,
      data: base64Data,
    },
  };

  const sizeSuffix = optimized
    ? ` (optimized from ${(stat.size / 1024).toFixed(0)} KB to ${(
        buffer.length / 1024
      ).toFixed(0)} KB)`
    : "";

  return {
    content: `Image loaded: ${resolvedPath} (${buffer.length} bytes, ${detectedType})${sizeSuffix}`,
    isError: false,
    contentBlocks: [imageBlock],
  };
}
