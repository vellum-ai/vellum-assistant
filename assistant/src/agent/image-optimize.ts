import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseImageDimensions } from "../context/image-dimensions.js";
import { getWorkspaceDir } from "../util/platform.js";

// Anthropic's documented max dimension — images larger than this are scaled
// down server-side anyway, so pre-scaling is zero quality loss.
const MAX_DIMENSION = 1568;

// Threshold below which we skip optimization — small images don't need it.
const OPTIMIZE_THRESHOLD_BYTES = 300 * 1024; // 300 KB

const JPEG_QUALITY = 80;

// Content-addressed disk cache to avoid re-running sips on the same image.
const CACHE_SUBDIR = "cache/optimized-images";
const CACHE_MAX_ENTRIES = 500;

function getCacheDir(): string {
  return join(getWorkspaceDir(), CACHE_SUBDIR);
}

function readFromCache(
  key: string,
): { data: string; mediaType: string } | null {
  try {
    const cachePath = join(getCacheDir(), `${key}.jpg`);
    if (!existsSync(cachePath)) return null;
    const buf = readFileSync(cachePath) as Buffer;
    return { data: buf.toString("base64"), mediaType: "image/jpeg" };
  } catch {
    return null;
  }
}

function writeToCache(key: string, optimizedBytes: Buffer): void {
  try {
    const dir = getCacheDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.jpg`), optimizedBytes);
    evictIfNeeded(dir);
  } catch {
    // Cache write failure is non-fatal.
  }
}

function evictIfNeeded(dir: string): void {
  try {
    const entries = readdirSync(dir)
      .filter((f) => f.endsWith(".jpg"))
      .map((f) => {
        const full = join(dir, f);
        return { path: full, mtimeMs: statSync(full).mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = entries.length - CACHE_MAX_ENTRIES;
    for (let i = 0; i < excess; i++) {
      try {
        unlinkSync(entries[i]!.path);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function runSips(inputBytes: Buffer): Buffer | null {
  const srcPath = join(tmpdir(), `vellum-img-opt-${Date.now()}-src`);
  const outPath = join(tmpdir(), `vellum-img-opt-${Date.now()}-out.jpg`);
  try {
    writeFileSync(srcPath, inputBytes);
    execFileSync(
      "sips",
      [
        "--resampleHeightWidthMax",
        String(MAX_DIMENSION),
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(JPEG_QUALITY),
        srcPath,
        "--out",
        outPath,
      ],
      { stdio: "pipe", timeout: 15_000 },
    );
    return readFileSync(outPath) as Buffer;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(srcPath);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(outPath);
    } catch {
      /* ignore */
    }
  }
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
 * Results are cached on disk by content hash so repeated sends of the same
 * image (or daemon restarts) skip the sips call entirely.
 */
export function optimizeImageForTransport(
  base64Data: string,
  mediaType: string,
): { data: string; mediaType: string } {
  const rawBytes = Buffer.from(base64Data, "base64");

  // Small images don't need optimization.
  if (rawBytes.length <= OPTIMIZE_THRESHOLD_BYTES) {
    return { data: base64Data, mediaType };
  }

  // If dimensions are already within limits, skip.
  const dims = parseImageDimensions(base64Data, mediaType);
  if (
    dims &&
    dims.width <= MAX_DIMENSION &&
    dims.height <= MAX_DIMENSION
  ) {
    return { data: base64Data, mediaType };
  }

  // Content-addressed cache lookup.
  const hash = createHash("sha256").update(rawBytes).digest("hex");
  const cacheKey = hash.slice(0, 16);
  const cached = readFromCache(cacheKey);
  if (cached) return cached;

  // Run sips (macOS). On other platforms this gracefully returns null.
  const optimized = runSips(rawBytes);
  if (!optimized) {
    return { data: base64Data, mediaType };
  }

  writeToCache(cacheKey, optimized);
  return { data: optimized.toString("base64"), mediaType: "image/jpeg" };
}
