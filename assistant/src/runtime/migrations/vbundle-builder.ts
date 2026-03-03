/**
 * Builds .vbundle archive files for migration export.
 *
 * A .vbundle is a gzip-compressed tar archive containing:
 * - manifest.json: metadata with schema_version, checksums, and bundle info
 * - data/db/assistant.db: the SQLite database (placeholder in skeleton mode)
 * - Additional config files as declared in the manifest
 *
 * This module produces the archive skeleton with correct file layout and
 * checksums. PR-3 will populate the actual conversation/memory data.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import type {
  ManifestFileEntryType,
  ManifestType,
} from "./vbundle-validator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VBundleFileEntry {
  path: string;
  data: Uint8Array;
}

export interface BuildVBundleOptions {
  /** Files to include in the archive. Must include data/db/assistant.db. */
  files: VBundleFileEntry[];
  /** Schema version for the manifest. Defaults to "1.0". */
  schemaVersion?: string;
  /** Source identifier (e.g. "runtime-export"). */
  source?: string;
  /** Human-readable description. */
  description?: string;
}

export interface BuildVBundleResult {
  /** The complete .vbundle archive as gzipped tar bytes. */
  archive: Uint8Array;
  /** The manifest that was embedded in the archive. */
  manifest: ManifestType;
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Canonicalize a JSON object by sorting keys recursively, then stringify.
 * Matches the canonicalization used by vbundle-validator.
 */
function canonicalizeJson(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

// ---------------------------------------------------------------------------
// Tar archive builder (minimal, ustar-compatible)
// ---------------------------------------------------------------------------

const BLOCK_SIZE = 512;

function padToBlock(data: Uint8Array): Uint8Array {
  const remainder = data.length % BLOCK_SIZE;
  if (remainder === 0) return data;
  const padded = new Uint8Array(data.length + (BLOCK_SIZE - remainder));
  padded.set(data);
  return padded;
}

function writeOctal(
  buf: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const str = value.toString(8).padStart(length - 1, "0");
  for (let i = 0; i < str.length; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
  buf[offset + length - 1] = 0;
}

function computeHeaderChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    if (i >= 148 && i < 156) {
      sum += 0x20; // space placeholder per tar spec
    } else {
      sum += header[i];
    }
  }
  return sum;
}

function createTarEntry(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  const encoder = new TextEncoder();

  // File name (0-99)
  const nameBytes = encoder.encode(name);
  header.set(nameBytes.subarray(0, 100), 0);

  // File mode (100-107): 0644
  writeOctal(header, 100, 8, 0o644);

  // Owner ID (108-115)
  writeOctal(header, 108, 8, 0);

  // Group ID (116-123)
  writeOctal(header, 116, 8, 0);

  // File size (124-135)
  writeOctal(header, 124, 12, data.length);

  // Modification time (136-147)
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));

  // Type flag (156): regular file
  header[156] = "0".charCodeAt(0);

  // USTAR magic (257-262)
  const magic = encoder.encode("ustar\0");
  header.set(magic, 257);

  // USTAR version (263-264)
  header[263] = "0".charCodeAt(0);
  header[264] = "0".charCodeAt(0);

  // Compute and write checksum (148-155)
  const checksum = computeHeaderChecksum(header);
  writeOctal(header, 148, 7, checksum);
  header[155] = 0x20; // trailing space

  // Combine header + padded data
  const paddedData = padToBlock(data);
  const result = new Uint8Array(header.length + paddedData.length);
  result.set(header, 0);
  result.set(paddedData, header.length);
  return result;
}

function createTarArchive(
  entries: Array<{ name: string; data: Uint8Array }>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(createTarEntry(entry.name, entry.data));
  }
  // End-of-archive: two zero blocks
  parts.push(new Uint8Array(BLOCK_SIZE * 2));

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/**
 * Build a .vbundle archive from the given files and metadata.
 *
 * Generates a valid manifest with SHA-256 checksums for all files and
 * a self-referencing manifest_sha256 checksum. The archive is returned
 * as gzip-compressed tar bytes.
 */
export function buildVBundle(options: BuildVBundleOptions): BuildVBundleResult {
  const {
    files,
    schemaVersion = "1.0",
    source = "runtime-export",
    description = "Runtime export bundle",
  } = options;

  // Build file entries for the manifest
  const fileEntries: ManifestFileEntryType[] = files.map((f) => ({
    path: f.path,
    sha256: sha256Hex(f.data),
    size: f.data.length,
  }));

  // Build manifest without the self-checksum
  const manifestWithoutChecksum = {
    schema_version: schemaVersion,
    created_at: new Date().toISOString(),
    source,
    description,
    files: fileEntries,
  };

  // Compute the manifest self-checksum
  const manifestSha256 = sha256Hex(canonicalizeJson(manifestWithoutChecksum));
  const manifest: ManifestType = {
    ...manifestWithoutChecksum,
    manifest_sha256: manifestSha256,
  };

  const manifestData = new TextEncoder().encode(JSON.stringify(manifest));

  // Build tar entries: manifest first, then all files
  const tarEntries = [
    { name: "manifest.json", data: manifestData },
    ...files.map((f) => ({ name: f.path, data: f.data })),
  ];

  const tar = createTarArchive(tarEntries);
  const archive = gzipSync(tar);

  return { archive, manifest };
}

// ---------------------------------------------------------------------------
// Skeleton builder
// ---------------------------------------------------------------------------

/**
 * Build a skeleton .vbundle with placeholder content.
 *
 * The skeleton includes:
 * - manifest.json with proper metadata and checksums
 * - data/db/assistant.db as an empty placeholder
 * - config/settings.json as an empty JSON object placeholder
 *
 * PR-3 will replace the placeholder data with actual exported content.
 */
export function buildSkeletonVBundle(options?: {
  source?: string;
  description?: string;
}): BuildVBundleResult {
  // Placeholder SQLite database (empty file)
  const dbPlaceholder = new Uint8Array(0);

  // Placeholder config
  const configPlaceholder = new TextEncoder().encode("{}");

  return buildVBundle({
    files: [
      { path: "data/db/assistant.db", data: dbPlaceholder },
      { path: "config/settings.json", data: configPlaceholder },
    ],
    source: options?.source ?? "runtime-export",
    description: options?.description ?? "Runtime export bundle (skeleton)",
  });
}
