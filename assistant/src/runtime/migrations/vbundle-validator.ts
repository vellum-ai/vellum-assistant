/**
 * Validates .vbundle archive files for migration import/export.
 *
 * A .vbundle is a gzip-compressed tar archive containing:
 * - manifest.json: metadata with schema_version, checksums, and bundle info
 * - data/db/assistant.db: the SQLite database
 * - Additional config files as declared in the manifest
 *
 * Validation steps:
 * 1. Archive structure: valid gzip tar with required entries
 * 2. Manifest schema: required fields and correct types
 * 3. Manifest checksum: SHA-256 of canonicalized JSON matches declared digest
 * 4. Per-file content integrity: SHA-256 of each file matches manifest checksums
 */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { z } from "zod";

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

const ManifestFileEntry = z.object({
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
});

const ManifestSchema = z.object({
  schema_version: z.string(),
  created_at: z.string(),
  source: z.string().optional(),
  description: z.string().optional(),
  files: z.array(ManifestFileEntry),
  manifest_sha256: z.string(),
});

export type ManifestFileEntryType = z.infer<typeof ManifestFileEntry>;
export type ManifestType = z.infer<typeof ManifestSchema>;

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

export interface ValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface VBundleTarEntry {
  name: string;
  data: Uint8Array;
  size: number;
}

export interface VBundleValidationResult {
  is_valid: boolean;
  errors: ValidationError[];
  manifest?: ManifestType;
  /** Parsed tar entries — only present when validation succeeds, so callers
   *  can reuse them without decompressing the archive a second time. */
  entries?: Map<string, VBundleTarEntry>;
}

// ---------------------------------------------------------------------------
// Tar parsing (minimal, spec-compliant for ustar/GNU tar)
// ---------------------------------------------------------------------------

interface TarEntry {
  name: string;
  data: Uint8Array;
  size: number;
}

/**
 * Parse a raw tar archive (uncompressed) into its entries.
 * Handles ustar and GNU tar long name extensions.
 */
function parseTar(buffer: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  const BLOCK_SIZE = 512;
  let longName: string | null = null;

  while (offset + BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE);

    // Check for end-of-archive (two consecutive zero blocks)
    if (header.every((b) => b === 0)) {
      break;
    }

    // Extract file name
    let name: string;
    if (longName) {
      name = longName;
      longName = null;
    } else {
      // POSIX ustar: prefix (345 bytes at 345) + name (100 bytes at 0)
      const rawName = decodeNullTerminated(header, 0, 100);
      const prefix = decodeNullTerminated(header, 345, 155);
      name = prefix ? `${prefix}/${rawName}` : rawName;
    }

    // File type (byte 156)
    const typeFlag = String.fromCharCode(header[156]);

    // File size in octal (bytes 124-135)
    const sizeStr = decodeNullTerminated(header, 124, 12);
    const size = parseInt(sizeStr, 8) || 0;

    // Calculate data blocks
    const dataBlocks = Math.ceil(size / BLOCK_SIZE);
    const dataStart = offset + BLOCK_SIZE;
    const data = buffer.subarray(dataStart, dataStart + size);

    // GNU tar long name extension (type 'L')
    if (typeFlag === "L") {
      longName = new TextDecoder().decode(data).replace(/\0+$/, "");
      offset = dataStart + dataBlocks * BLOCK_SIZE;
      continue;
    }

    // PAX extended header (type 'x') — extract path= attribute for next entry
    if (typeFlag === "x") {
      const paxText = new TextDecoder().decode(data);
      const pathMatch = paxText.match(/\d+ path=([^\n]+)\n/);
      if (pathMatch) {
        longName = pathMatch[1];
      }
      offset = dataStart + dataBlocks * BLOCK_SIZE;
      continue;
    }

    // Regular file or hard link
    if (typeFlag === "0" || typeFlag === "\0" || typeFlag === "") {
      entries.push({ name: normalizePath(name), data, size });
    }

    offset = dataStart + dataBlocks * BLOCK_SIZE;
  }

  return entries;
}

function decodeNullTerminated(
  buf: Uint8Array,
  start: number,
  maxLen: number,
): string {
  let end = start;
  while (end < start + maxLen && buf[end] !== 0) {
    end++;
  }
  return new TextDecoder().decode(buf.subarray(start, end));
}

function normalizePath(p: string): string {
  // Remove leading ./ and trailing /
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Canonicalize a JSON object by sorting keys recursively, then SHA-256 hash it.
 * This matches the platform's canonicalization approach.
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
// Core validation
// ---------------------------------------------------------------------------

const REQUIRED_ENTRIES = ["manifest.json", "data/db/assistant.db"];

// 2 GB — must accommodate large but valid migrations from buildExportVBundle()
const MAX_DECOMPRESSED_SIZE = 2 * 1024 * 1024 * 1024;

/**
 * Validate a .vbundle archive from raw bytes.
 *
 * Performs four validation passes:
 * 1. Archive structure (gzip decompression, tar parsing, required entries)
 * 2. Manifest schema (Zod validation of manifest.json)
 * 3. Manifest checksum (SHA-256 of canonicalized JSON without manifest_sha256)
 * 4. Per-file content integrity (SHA-256 of each file vs manifest declaration)
 */
export function validateVBundle(data: Uint8Array): VBundleValidationResult {
  const errors: ValidationError[] = [];

  // Step 1: Decompress gzip with size cap to prevent zip-bomb DoS
  let tarData: Uint8Array;
  try {
    tarData = gunzipSync(data, { maxOutputLength: MAX_DECOMPRESSED_SIZE });
  } catch (err) {
    const message =
      err instanceof RangeError
        ? `Decompressed archive exceeds ${MAX_DECOMPRESSED_SIZE} byte limit`
        : `Archive is not a valid gzip file: ${
            err instanceof Error ? err.message : String(err)
          }`;
    const code =
      err instanceof RangeError ? "DECOMPRESSED_SIZE_EXCEEDED" : "INVALID_GZIP";
    errors.push({ code, message });
    return { is_valid: false, errors };
  }

  // Step 2: Parse tar
  let entries: TarEntry[];
  try {
    entries = parseTar(tarData);
  } catch (err) {
    errors.push({
      code: "INVALID_TAR",
      message: `Archive is not a valid tar file: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return { is_valid: false, errors };
  }

  // Build a lookup map for entries
  const entryMap = new Map<string, TarEntry>();
  for (const entry of entries) {
    entryMap.set(entry.name, entry);
  }

  // Step 3: Check required entries
  for (const required of REQUIRED_ENTRIES) {
    if (!entryMap.has(required)) {
      errors.push({
        code: "MISSING_ENTRY",
        message: `Required archive entry not found: ${required}`,
        path: required,
      });
    }
  }

  // If manifest.json is missing, we cannot proceed with further validation
  const manifestEntry = entryMap.get("manifest.json");
  if (!manifestEntry) {
    return { is_valid: false, errors };
  }

  // Step 4: Parse and validate manifest schema
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(new TextDecoder().decode(manifestEntry.data));
  } catch (err) {
    errors.push({
      code: "INVALID_MANIFEST_JSON",
      message: `manifest.json is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      path: "manifest.json",
    });
    return { is_valid: false, errors };
  }

  const parseResult = ManifestSchema.safeParse(manifestRaw);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      errors.push({
        code: "MANIFEST_SCHEMA_ERROR",
        message: `Manifest validation error at ${issue.path.join(".")}: ${
          issue.message
        }`,
        path: `manifest.json/${issue.path.join(".")}`,
      });
    }
    return { is_valid: false, errors };
  }

  const manifest = parseResult.data;

  // Step 5: Verify manifest checksum
  // The manifest_sha256 field is the SHA-256 of the canonicalized JSON
  // with the manifest_sha256 field itself excluded.
  const manifestForChecksum = { ...(manifestRaw as Record<string, unknown>) };
  delete manifestForChecksum.manifest_sha256;
  const canonicalized = canonicalizeJson(manifestForChecksum);
  const computedManifestSha256 = sha256Hex(canonicalized);

  if (computedManifestSha256 !== manifest.manifest_sha256) {
    errors.push({
      code: "MANIFEST_CHECKSUM_MISMATCH",
      message: `Manifest checksum mismatch: expected ${manifest.manifest_sha256}, computed ${computedManifestSha256}`,
      path: "manifest.json",
    });
  }

  // Step 6: Verify per-file content integrity
  const manifestFilePaths = new Set(manifest.files.map((f) => f.path));

  for (const fileEntry of manifest.files) {
    const archiveEntry = entryMap.get(fileEntry.path);
    if (!archiveEntry) {
      errors.push({
        code: "MISSING_DECLARED_FILE",
        message: `File declared in manifest not found in archive: ${fileEntry.path}`,
        path: fileEntry.path,
      });
      continue;
    }

    // Verify size
    if (archiveEntry.size !== fileEntry.size) {
      errors.push({
        code: "FILE_SIZE_MISMATCH",
        message: `Size mismatch for ${fileEntry.path}: manifest declares ${fileEntry.size} bytes, archive has ${archiveEntry.size} bytes`,
        path: fileEntry.path,
      });
    }

    // Verify SHA-256
    const computedSha256 = sha256Hex(archiveEntry.data);
    if (computedSha256 !== fileEntry.sha256) {
      errors.push({
        code: "FILE_CHECKSUM_MISMATCH",
        message: `Checksum mismatch for ${fileEntry.path}: expected ${fileEntry.sha256}, computed ${computedSha256}`,
        path: fileEntry.path,
      });
    }
  }

  // Step 7: Ensure every required entry (except manifest.json itself) has a
  // checksum in the manifest — presence in the archive alone is not enough.
  for (const required of REQUIRED_ENTRIES) {
    if (required === "manifest.json") continue;
    if (!entryMap.has(required)) continue;
    if (!manifestFilePaths.has(required)) {
      errors.push({
        code: "REQUIRED_FILE_NOT_IN_MANIFEST",
        message: `Required file ${required} exists in archive but has no checksum entry in manifest.files`,
        path: required,
      });
    }
  }

  return {
    is_valid: errors.length === 0,
    errors,
    manifest: errors.length === 0 ? manifest : undefined,
    entries: errors.length === 0 ? entryMap : undefined,
  };
}
