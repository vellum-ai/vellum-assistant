/**
 * Validates .vbundle archive files for migration import/export.
 *
 * A .vbundle is a gzip-compressed tar archive containing:
 * - manifest.json: metadata with schema_version, checksums, and bundle info
 * - workspace/: the entire workspace directory tree (new format), OR
 *   data/db/assistant.db + config/settings.json (old format)
 *
 * Validation steps:
 * 1. Archive structure: valid gzip tar with required entries
 * 2. Manifest schema: required fields and correct types
 * 3. Manifest checksum: SHA-256 of canonicalized JSON matches declared digest
 * 4. Per-file content integrity: SHA-256 of each file matches manifest checksums
 */

import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { gunzipSync } from "node:zlib";

import { z } from "zod";

// ---------------------------------------------------------------------------
// Manifest schema (v1)
// ---------------------------------------------------------------------------

const ManifestFileEntry = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size_bytes: z.number().int().nonnegative(),
  link_target: z.string().min(1).optional(),
});

const AssistantInfo = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  runtime_version: z.string().min(1),
});

const Origin = z.object({
  mode: z.enum(["managed", "self-hosted-remote", "self-hosted-local"]),
  platform_version: z.string().optional(),
  hostname: z.string().optional(),
});

const Compatibility = z.object({
  min_runtime_version: z.string().min(1),
  max_runtime_version: z.string().nullable(),
});

const ExportOptions = z.object({
  include_logs: z.boolean(),
  include_browser_state: z.boolean(),
  include_memory_vectors: z.boolean(),
});

export const ManifestSchema = z
  .object({
    schema_version: z.literal(1),
    bundle_id: z.string().uuid(),
    created_at: z.string().datetime({ offset: true }),
    assistant: AssistantInfo,
    origin: Origin,
    compatibility: Compatibility,
    contents: z.array(ManifestFileEntry),
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
    secrets_redacted: z.boolean(),
    export_options: ExportOptions,
  })
  .refine((m) => m.origin.mode !== "managed" || m.secrets_redacted === true, {
    message: "secrets_redacted must be true when origin.mode is 'managed'",
    path: ["secrets_redacted"],
  })
  .refine(
    (m) =>
      m.contents.some(
        (f) =>
          f.path === "data/db/assistant.db" ||
          f.path === "workspace/data/db/assistant.db",
      ),
    {
      message:
        "contents must include an entry for data/db/assistant.db (legacy format) or workspace/data/db/assistant.db (current format)",
      path: ["contents"],
    },
  );

export type ManifestFileEntryType = z.infer<typeof ManifestFileEntry>;
export type ManifestType = z.infer<typeof ManifestSchema>;

// ---------------------------------------------------------------------------
// Legacy manifest schema (pre-v1, six-field shape)
// ---------------------------------------------------------------------------
//
// Older runtime versions wrote a six-field manifest with `schema_version: "1.0"`,
// `files`, `size` (per-entry), and a self-referencing `manifest_sha256` field.
// Existing on-disk artifacts produced by those versions — backup snapshots,
// cross-version migration bundles — must keep validating after upgrade,
// per AGENTS.md "no silent breaks of persisted state".
//
// We accept legacy bundles via a fallback parse + translator so the rest of
// the validation pipeline (per-file hash + size verification) only ever sees
// the v1 shape.

const LegacyManifestFileEntry = z.object({
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
});

export const LegacyManifestSchema = z.object({
  schema_version: z.string(),
  created_at: z.string(),
  source: z.string().optional(),
  description: z.string().optional(),
  files: z.array(LegacyManifestFileEntry),
  manifest_sha256: z.string(),
});

export type LegacyManifestType = z.infer<typeof LegacyManifestSchema>;

/**
 * Recompute the legacy `manifest_sha256` field — strips the field entirely
 * (rather than emptying it) before canonicalizing, matching the pre-v1
 * producer behavior. Required so legacy bundles whose checksum was computed
 * the old way still verify after upgrade.
 */
export function computeLegacyManifestSha256(manifest: unknown): string {
  const copy = { ...(manifest as Record<string, unknown>) };
  delete copy.manifest_sha256;
  return sha256Hex(canonicalizeJson(copy));
}

/**
 * Coerce a legacy ISO-ish `created_at` into the v1 datetime regex shape.
 * Pre-v1 producers always wrote `new Date().toISOString()`, which already
 * has the `Z` suffix the v1 regex requires; this helper is defensive against
 * any historical producer that omitted the offset/`Z`.
 */
function coerceLegacyCreatedAt(raw: string): string {
  // If the string already parses as a Date, keep it as the canonical ISO form.
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    // `toISOString()` always emits the `...Z` form the v1 regex accepts.
    return parsed.toISOString();
  }
  return raw;
}

/**
 * Translate a parsed legacy manifest into a v1 `ManifestType` so the rest of
 * the validator pipeline can operate on a uniform shape.
 *
 * Legacy bundles never carried assistant identity, origin, compatibility, or
 * export-option signals; we substitute conservative placeholders that satisfy
 * the v1 schema's `.refine()` rules without misrepresenting the source bundle.
 */
export function translateLegacyManifest(
  legacy: LegacyManifestType,
): ManifestType {
  return {
    schema_version: 1,
    bundle_id: randomUUID(),
    created_at: coerceLegacyCreatedAt(legacy.created_at),
    assistant: {
      id: "self",
      name: "Assistant",
      runtime_version: "0.0.0-legacy",
    },
    // Legacy bundles came from the local self-hosted exporter; the
    // conservative default is "self-hosted-local" so the v1 managed/secrets
    // refine never trips on a translated legacy bundle.
    origin: { mode: "self-hosted-local" },
    compatibility: {
      min_runtime_version: "0.0.0-legacy",
      max_runtime_version: null,
    },
    contents: legacy.files.map((f) => ({
      path: f.path,
      sha256: f.sha256,
      size_bytes: f.size,
    })),
    checksum: legacy.manifest_sha256,
    secrets_redacted: false,
    export_options: {
      include_logs: false,
      include_browser_state: false,
      include_memory_vectors: false,
    },
  };
}

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
  /** Set when the tar entry is typeflag-2 (symlink); carries the link target
   *  decoded from the ustar linkname field. */
  linkname?: string;
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
  /** Set when the tar entry is typeflag-2 (symlink); carries the link target
   *  decoded from the ustar linkname field. */
  linkname?: string;
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

    // Symlink (type '2') — empty body regardless of declared size; the link
    // target lives in the ustar linkname field (157..256). We preserve the
    // tar-declared `size` here (rather than forcing it to 0) so the
    // downstream `archiveEntry.size !== 0` check can surface
    // `FILE_SIZE_MISMATCH` on malformed symlink headers. The body itself is
    // always an empty buffer — symlinks have no data body even if the
    // header lies about it.
    if (typeFlag === "2") {
      const linkname = decodeNullTerminated(header, 157, 100);
      entries.push({
        name: normalizePath(name),
        data: new Uint8Array(0),
        size,
        linkname,
      });
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
export function canonicalizeJson(obj: unknown): string {
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

/**
 * Recompute the `checksum` field for a manifest object.
 *
 * The v1 schema spec says the checksum is computed over the canonicalized
 * manifest with the `checksum` field set to the empty string (not absent),
 * so we replace it before canonicalizing — both producers and validators
 * must agree on this exact wire shape. Centralized here so the streaming
 * validator and the in-memory validator agree on the exact canonicalization.
 */
export function computeManifestChecksum(manifest: unknown): string {
  const copy = { ...(manifest as Record<string, unknown>), checksum: "" };
  return sha256Hex(canonicalizeJson(copy));
}

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

// Only manifest.json is structurally required. The DB and config live under
// workspace/ (new format) or data/db/ + config/ (old format) — both are valid.
const REQUIRED_ENTRIES = ["manifest.json"];

// 2 GB — must accommodate large but valid migrations from buildExportVBundle()
const MAX_DECOMPRESSED_SIZE = 2 * 1024 * 1024 * 1024;

/**
 * Validate a .vbundle archive from raw bytes.
 *
 * Performs four validation passes:
 * 1. Archive structure (gzip decompression, tar parsing, required entries)
 * 2. Manifest schema (Zod validation of manifest.json)
 * 3. Manifest checksum (SHA-256 of canonicalized JSON with the `checksum` field set to empty string)
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

  // Try the v1 schema first. If that fails, fall back to the legacy six-field
  // shape so existing on-disk bundles (backup snapshots, cross-version
  // migrations) keep validating after upgrade. AGENTS.md prohibits silent
  // breaks of persisted state.
  const parseResult = ManifestSchema.safeParse(manifestRaw);
  let manifest: ManifestType;

  if (parseResult.success) {
    manifest = parseResult.data;

    // Step 5 (v1): Verify manifest checksum — SHA-256 of canonicalized JSON
    // with the `checksum` field replaced by an empty string.
    const computedChecksum = computeManifestChecksum(manifestRaw);
    if (computedChecksum !== manifest.checksum) {
      errors.push({
        code: "MANIFEST_CHECKSUM_MISMATCH",
        message: `Manifest checksum mismatch: expected ${manifest.checksum}, computed ${computedChecksum}`,
        path: "manifest.json",
      });
    }
  } else {
    const legacyParse = LegacyManifestSchema.safeParse(manifestRaw);
    if (!legacyParse.success) {
      // Truly malformed — surface the v1 error for the clearer error trail.
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

    // Step 5 (legacy): Verify the legacy `manifest_sha256` using the OLD
    // canonicalization (strip the field entirely; do NOT replace with "").
    const legacy = legacyParse.data;
    const computedLegacyChecksum = computeLegacyManifestSha256(manifestRaw);
    if (computedLegacyChecksum !== legacy.manifest_sha256) {
      errors.push({
        code: "MANIFEST_CHECKSUM_MISMATCH",
        message: `Manifest checksum mismatch: expected ${legacy.manifest_sha256}, computed ${computedLegacyChecksum}`,
        path: "manifest.json",
      });
      return { is_valid: false, errors };
    }

    // Translate to v1 so the rest of the pipeline (per-file hash + size
    // verification, refine rules) sees a uniform shape.
    manifest = translateLegacyManifest(legacy);
  }

  // Step 6: Verify per-file content integrity
  const manifestFilePaths = new Set(manifest.contents.map((f) => f.path));

  for (const fileEntry of manifest.contents) {
    const archiveEntry = entryMap.get(fileEntry.path);
    if (!archiveEntry) {
      errors.push({
        code: "MISSING_DECLARED_FILE",
        message: `File declared in manifest not found in archive: ${fileEntry.path}`,
        path: fileEntry.path,
      });
      continue;
    }

    if (fileEntry.link_target !== undefined) {
      // Symlink branch: typeflag agreement, linkname agreement, sha over the
      // link target string, size==0 on both sides, and path-traversal rejection.
      if (archiveEntry.linkname === undefined) {
        errors.push({
          code: "SYMLINK_TYPEFLAG_MISMATCH",
          message: `Manifest declares symlink for ${fileEntry.path} but tar entry is not typeflag-2`,
          path: fileEntry.path,
        });
        continue;
      }

      if (archiveEntry.linkname !== fileEntry.link_target) {
        errors.push({
          code: "LINK_TARGET_MISMATCH",
          message: `Symlink linkname mismatch for ${fileEntry.path}: manifest declares "${fileEntry.link_target}", tar carries "${archiveEntry.linkname}"`,
          path: fileEntry.path,
        });
        continue;
      }

      if (archiveEntry.size !== 0) {
        errors.push({
          code: "FILE_SIZE_MISMATCH",
          message: `Size mismatch for ${fileEntry.path}: manifest declares ${fileEntry.size_bytes} bytes, archive has ${archiveEntry.size} bytes`,
          path: fileEntry.path,
        });
      }

      if (fileEntry.size_bytes !== 0) {
        errors.push({
          code: "FILE_SIZE_MISMATCH",
          message: `Size mismatch for ${fileEntry.path}: manifest declares ${fileEntry.size_bytes} bytes, archive has ${archiveEntry.size} bytes`,
          path: fileEntry.path,
        });
      }

      const expected = sha256Hex(fileEntry.link_target);
      if (expected !== fileEntry.sha256) {
        errors.push({
          code: "FILE_CHECKSUM_MISMATCH",
          message: `Checksum mismatch for ${fileEntry.path}: expected ${fileEntry.sha256}, computed ${expected}`,
          path: fileEntry.path,
        });
      }

      // Absolute POSIX targets are unconstrained by the bundle root — reject
      // them up front. The `posix.normalize` guard below only catches
      // `..`-based escapes; an absolute path like `/etc/passwd` survives
      // normalization unchanged and would otherwise pass.
      if (fileEntry.link_target.startsWith("/")) {
        errors.push({
          code: "SYMLINK_TARGET_ESCAPES_ARCHIVE",
          message: `Symlink target is absolute, which escapes the archive root for ${fileEntry.path}: target=${fileEntry.link_target}`,
          path: fileEntry.path,
        });
      } else {
        const normalized = posix.normalize(
          posix.join(posix.dirname(fileEntry.path), fileEntry.link_target),
        );
        // Defense-in-depth: also reject if the joined+normalized path is
        // absolute, in case `dirname` ever resolves to an absolute root.
        if (
          normalized.startsWith("../") ||
          normalized === ".." ||
          normalized.startsWith("/")
        ) {
          errors.push({
            code: "SYMLINK_TARGET_ESCAPES_ARCHIVE",
            message: `Symlink target escapes archive root for ${fileEntry.path}: target=${fileEntry.link_target}, normalized=${normalized}`,
            path: fileEntry.path,
          });
        }
      }
      continue;
    }

    if (archiveEntry.linkname !== undefined) {
      // Tar carries a typeflag-2 entry but manifest declares a regular file.
      errors.push({
        code: "SYMLINK_NOT_DECLARED",
        message: `Tar entry ${fileEntry.path} is typeflag-2 but manifest does not declare link_target`,
        path: fileEntry.path,
      });
      continue;
    }

    // Verify size
    if (archiveEntry.size !== fileEntry.size_bytes) {
      errors.push({
        code: "FILE_SIZE_MISMATCH",
        message: `Size mismatch for ${fileEntry.path}: manifest declares ${fileEntry.size_bytes} bytes, archive has ${archiveEntry.size} bytes`,
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
        message: `Required file ${required} exists in archive but has no checksum entry in manifest.contents`,
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
