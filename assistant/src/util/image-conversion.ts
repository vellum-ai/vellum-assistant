/**
 * JPEG conversion for images, backed by macOS `sips`.
 *
 * Two consumers share this converter:
 *   - transport optimization (`agent/image-optimize.ts`) downscales large
 *     images before provider calls;
 *   - storage normalization (attachment ingress + history hydration) converts
 *     HEIF/HEIC — which Chromium-based clients cannot decode — to JPEG.
 *
 * Conversion runs `sips` (a macOS builtin); on other platforms or on any
 * failure it returns null and callers keep the original bytes. Results are
 * cached on disk keyed by content hash + conversion options, so repeated
 * conversions of the same image (or daemon restarts) skip the sips call.
 */

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

import { v4 as uuid } from "uuid";

const DEFAULT_JPEG_QUALITY = 80;

/** Full-resolution quality for stored attachment masters. */
const STORAGE_JPEG_QUALITY = 90;

const CACHE_MAX_ENTRIES = 500;

function getCacheDir(): string {
  return join(tmpdir(), "vellum-optimized-images");
}

function readFromCache(key: string): Buffer | null {
  try {
    const cachePath = join(getCacheDir(), `${key}.jpg`);
    if (!existsSync(cachePath)) return null;
    return readFileSync(cachePath) as Buffer;
  } catch {
    return null;
  }
}

function writeToCache(key: string, convertedBytes: Buffer): void {
  try {
    const dir = getCacheDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.jpg`), convertedBytes);
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

export interface ConvertToJpegOptions {
  /** Downscale so neither side exceeds this; omit to keep full resolution. */
  maxDimensionPx?: number;
  /**
   * Resample to exactly these pixel dimensions (up- or downscaling). The
   * caller is responsible for preserving aspect ratio. Mutually exclusive
   * with `maxDimensionPx`; when both are set this wins.
   */
  resizeToPx?: { width: number; height: number };
  /** JPEG quality 1-100 (default 80). */
  quality?: number;
}

function runSips(
  inputBytes: Uint8Array,
  options: ConvertToJpegOptions,
): Buffer | null {
  const stamp = `${Date.now()}-${uuid().slice(0, 8)}`;
  const srcPath = join(tmpdir(), `vellum-img-opt-${stamp}-src`);
  const outPath = join(tmpdir(), `vellum-img-opt-${stamp}-out.jpg`);
  try {
    writeFileSync(srcPath, inputBytes);
    // `-z` resamples to an exact height/width (the only sips mode that can
    // upscale); `--resampleHeightWidthMax` only caps the longest side.
    const args =
      options.resizeToPx != null
        ? [
            "-z",
            String(options.resizeToPx.height),
            String(options.resizeToPx.width),
          ]
        : options.maxDimensionPx != null
          ? ["--resampleHeightWidthMax", String(options.maxDimensionPx)]
          : [];
    args.push(
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      String(options.quality ?? DEFAULT_JPEG_QUALITY),
      srcPath,
      "--out",
      outPath,
    );
    execFileSync("sips", args, { stdio: "pipe", timeout: 15_000 });
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
 * Convert an image to JPEG, optionally downscaling. Returns null when
 * conversion is unavailable (non-macOS) or fails; callers keep the original.
 */
export function convertImageToJpeg(
  bytes: Uint8Array,
  options: ConvertToJpegOptions = {},
): Buffer | null {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  // Options qualify the key so full-resolution storage conversions and
  // resized transport conversions of the same source never collide.
  const sizeKey =
    options.resizeToPx != null
      ? `${options.resizeToPx.width}x${options.resizeToPx.height}`
      : (options.maxDimensionPx ?? "full");
  const cacheKey = `${hash}-${sizeKey}-q${options.quality ?? DEFAULT_JPEG_QUALITY}`;

  const cached = readFromCache(cacheKey);
  if (cached) return cached;

  const converted = runSips(bytes, options);
  if (!converted) return null;

  writeToCache(cacheKey, converted);
  return converted;
}

// HEIF container brands (ISO BMFF `ftyp` major brand). AVIF brands are
// deliberately absent: Chromium decodes AVIF natively, so it needs no
// normalization.
const HEIF_FTYP_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heif",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);

/**
 * Content-based HEIF/HEIC detection. MIME metadata is unreliable here:
 * Chromium reports an empty `file.type` for `.heic`, which clients coerce to
 * `application/octet-stream`.
 */
export function isHeifImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  // ISO BMFF layout: bytes 4-8 are "ftyp", bytes 8-12 the major brand.
  if (
    bytes[4] !== 0x66 || // f
    bytes[5] !== 0x74 || // t
    bytes[6] !== 0x79 || // y
    bytes[7] !== 0x70 // p
  ) {
    return false;
  }
  const brand = String.fromCharCode(
    bytes[8]!,
    bytes[9]!,
    bytes[10]!,
    bytes[11]!,
  );
  return HEIF_FTYP_BRANDS.has(brand);
}

const HEIF_FILENAME_RE = /\.(heic|heif)$/i;

/**
 * Filename-extension HEIF/HEIC detection, for call sites that only hold
 * attachment metadata (filename + MIME) and want to skip hydrating bytes for
 * non-candidate rows. Complements {@link isHeifImage}: Chromium reports an
 * empty MIME for `.heic`, so legacy rows can carry HEIC bytes under
 * `application/octet-stream` while the extension survives.
 */
export function isHeicFilename(filename: string): boolean {
  return HEIF_FILENAME_RE.test(filename.trim());
}

/** Rewrites a filename's extension to `.jpg` (e.g. `IMG_5487.HEIC` → `IMG_5487.jpg`). */
export function jpegFilenameFor(filename: string): string {
  const fallback = "attachment";
  const trimmed = filename.trim() || fallback;
  if (/\.jpe?g$/i.test(trimmed)) return trimmed;
  const withoutExtension = trimmed.replace(/\.[^./\\]+$/, "") || fallback;
  return `${withoutExtension}.jpg`;
}

export interface NormalizedImageBytes {
  mimeType: string;
  bytes: Uint8Array;
  converted: boolean;
}

/**
 * Normalize image bytes for storage: HEIF/HEIC becomes a full-resolution JPEG
 * master; everything else (and any conversion failure) passes through
 * unchanged. Callers that persist a filename should rewrite it with
 * {@link jpegFilenameFor} when `converted` is true.
 */
export function normalizeImageBytes(
  mimeType: string,
  bytes: Uint8Array,
): NormalizedImageBytes {
  if (!isHeifImage(bytes)) {
    return { mimeType, bytes, converted: false };
  }
  const converted = convertImageToJpeg(bytes, {
    quality: STORAGE_JPEG_QUALITY,
  });
  if (!converted) {
    return { mimeType, bytes, converted: false };
  }
  return { mimeType: "image/jpeg", bytes: converted, converted: true };
}

export interface NormalizedImageBase64 {
  mimeType: string;
  dataBase64: string;
  converted: boolean;
}

/**
 * Base64 variant of {@link normalizeImageBytes}. Sniffs the decoded head
 * first so non-HEIF payloads skip the full decode.
 */
export function normalizeImageBase64(
  mimeType: string,
  dataBase64: string,
): NormalizedImageBase64 {
  // 16 base64 chars decode to the 12 bytes the ftyp sniff needs.
  const head = Buffer.from(dataBase64.slice(0, 16), "base64");
  if (!isHeifImage(head)) {
    return { mimeType, dataBase64, converted: false };
  }
  const normalized = normalizeImageBytes(
    mimeType,
    Buffer.from(dataBase64, "base64"),
  );
  if (!normalized.converted) {
    return { mimeType, dataBase64, converted: false };
  }
  return {
    mimeType: normalized.mimeType,
    dataBase64: Buffer.from(normalized.bytes).toString("base64"),
    converted: true,
  };
}
