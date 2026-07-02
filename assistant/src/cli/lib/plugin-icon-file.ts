/**
 * Validate a plugin's optional author-bundled `icon.png`.
 *
 * A plugin may ship a raster icon at a fixed path — `icon.png` in the plugin
 * root. The filename is fixed (no author-controlled path) so there is no
 * traversal surface. Validation is fail-closed: any problem — missing file,
 * wrong magic bytes, oversized bytes, oversized dimensions, unreadable —
 * resolves to `{ hasIcon: false }` and never throws, so callers can surface
 * "no icon" uniformly without per-source error handling.
 *
 * PNG-only by design: a single well-known container keeps the parser tiny
 * (magic signature + IHDR) and adds no dependency.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Fixed icon filename in the plugin root — no author path, no traversal. */
const ICON_FILENAME = "icon.png";
/** Byte cap: reject anything larger (also bounds what we read into memory). */
const MAX_ICON_BYTES = 32 * 1024;
/** Dimension cap (px) enforced against the IHDR width/height. */
const MAX_ICON_DIMENSION = 128;
/** PNG signature: the first 8 bytes of every PNG file. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Smallest prefix we need: 8-byte magic + 8-byte chunk header + IHDR w/h. */
const MIN_HEADER_BYTES = 24;

/** Result of validating a plugin's `icon.png`. */
export interface ValidatedPluginIcon {
  /** Whether a valid icon was found. `false` for every failure mode. */
  readonly hasIcon: boolean;
  /** First 16 hex chars of sha256(bytes) — a stable content version. */
  readonly iconVersion?: string;
  /** Absolute path to the validated `icon.png`. */
  readonly path?: string;
}

/**
 * Read and validate `<pluginDir>/icon.png`. Returns `{ hasIcon: true }` with a
 * content-hash `iconVersion` and `path` only when the file is a PNG whose IHDR
 * dimensions are within {@link MAX_ICON_DIMENSION} and whose size is within
 * {@link MAX_ICON_BYTES}. Every other case returns `{ hasIcon: false }`.
 */
export function readValidatedPluginIcon(
  pluginDir: string,
): ValidatedPluginIcon {
  const iconPath = join(pluginDir, ICON_FILENAME);

  let bytes: Buffer;
  try {
    const stat = statSync(iconPath);
    // Size-gate before reading so an oversized file never enters memory.
    // A missing file throws here and is caught as "no icon".
    if (!stat.isFile() || stat.size > MAX_ICON_BYTES) {
      return { hasIcon: false };
    }
    bytes = readFileSync(iconPath);
  } catch {
    return { hasIcon: false };
  }

  if (bytes.length < MIN_HEADER_BYTES || bytes.length > MAX_ICON_BYTES) {
    return { hasIcon: false };
  }
  if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return { hasIcon: false };
  }

  // IHDR width/height: big-endian uint32 at byte offsets 16 and 20.
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (
    width <= 0 ||
    height <= 0 ||
    width > MAX_ICON_DIMENSION ||
    height > MAX_ICON_DIMENSION
  ) {
    return { hasIcon: false };
  }

  const iconVersion = createHash("sha256")
    .update(bytes)
    .digest("hex")
    .slice(0, 16);
  return { hasIcon: true, iconVersion, path: iconPath };
}
