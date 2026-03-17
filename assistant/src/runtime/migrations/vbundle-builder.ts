/**
 * Builds .vbundle archive files for migration export.
 *
 * A .vbundle is a gzip-compressed tar archive containing:
 * - manifest.json: metadata with schema_version, checksums, and bundle info
 * - data/db/assistant.db: the SQLite database with conversations and memory
 * - config/settings.json: the assistant configuration
 * - trust/trust.json: trust rules (optional)
 * - skills/: workspace skills (optional)
 * - prompts/: workspace prompt files — IDENTITY.md, SOUL.md, USER.md, UPDATES.md (optional)
 * - hooks/: workspace hooks directory (optional)
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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

/**
 * Build a PAX extended header entry for paths that exceed the 100-byte ustar
 * limit. The PAX entry is a special tar record (typeflag 'x') whose body
 * contains "key=value" records. The following data entry uses a truncated name
 * in its ustar header, but tar extractors use the PAX path attribute instead.
 */
function createPaxPathEntry(name: string): Uint8Array {
  const encoder = new TextEncoder();

  // Build PAX payload: "<length> path=<name>\n"
  // The length field includes itself, the space, and the trailing newline.
  const record = `path=${name}\n`;
  // Start with a guess for the decimal length prefix
  let prefix = `${record.length + 2} `; // +2 for prefix digit + space (min)
  let full = `${prefix}${record}`;
  // Iterate until the length prefix is self-consistent
  while (new TextEncoder().encode(full).length !== Number.parseInt(prefix)) {
    prefix = `${new TextEncoder().encode(full).length} `;
    full = `${prefix}${record}`;
  }
  const paxData = encoder.encode(full);

  // Build a ustar header for the PAX entry itself
  const header = new Uint8Array(BLOCK_SIZE);

  // Use a synthetic name for the PAX header entry
  const paxName = encoder.encode("PaxHeader/entry");
  header.set(paxName.subarray(0, 100), 0);

  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, paxData.length);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));

  // Type flag 'x' = PAX extended header for the next entry
  header[156] = "x".charCodeAt(0);

  const magic = encoder.encode("ustar\0");
  header.set(magic, 257);
  header[263] = "0".charCodeAt(0);
  header[264] = "0".charCodeAt(0);

  const checksum = computeHeaderChecksum(header);
  writeOctal(header, 148, 7, checksum);
  header[155] = 0x20;

  const paddedData = padToBlock(paxData);
  const result = new Uint8Array(header.length + paddedData.length);
  result.set(header, 0);
  result.set(paddedData, header.length);
  return result;
}

function createTarEntry(name: string, data: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);

  // If the name exceeds 100 bytes, emit a PAX extended header first
  // so that the full path is preserved in the archive.
  const needsPax = nameBytes.length > 100;
  const paxEntry = needsPax ? createPaxPathEntry(name) : null;

  const header = new Uint8Array(BLOCK_SIZE);

  // File name (0-99) — truncated if >100 bytes; PAX header carries the full name
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
  const fileEntry = new Uint8Array(header.length + paddedData.length);
  fileEntry.set(header, 0);
  fileEntry.set(paddedData, header.length);

  if (paxEntry) {
    const result = new Uint8Array(paxEntry.length + fileEntry.length);
    result.set(paxEntry, 0);
    result.set(fileEntry, paxEntry.length);
    return result;
  }

  return fileEntry;
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
// Directory walker — recursively collects files for archive inclusion
// ---------------------------------------------------------------------------

/**
 * Recursively walk a directory and return all non-binary, non-symlink files
 * as VBundleFileEntry objects with paths prefixed by `archivePrefix`.
 */
function walkDirectory(dir: string, archivePrefix: string): VBundleFileEntry[] {
  const entries: VBundleFileEntry[] = [];

  function walk(currentDir: string): void {
    const dirEntries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const fullPath = join(currentDir, entry.name);

      // Skip symlinks
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        const data = new Uint8Array(readFileSync(fullPath));

        // Skip binary files: check first 8KB for null bytes
        const checkLength = Math.min(data.length, 8192);
        let isBinary = false;
        for (let i = 0; i < checkLength; i++) {
          if (data[i] === 0) {
            isBinary = true;
            break;
          }
        }
        if (isBinary) continue;

        const relativePath = relative(dir, fullPath);
        entries.push({
          path: `${archivePrefix}/${relativePath}`,
          data,
        });
      }
    }
  }

  walk(dir);
  return entries;
}

// ---------------------------------------------------------------------------
// Export builder — reads real data from disk
// ---------------------------------------------------------------------------

export interface BuildExportVBundleOptions {
  /** Path to the SQLite database file (e.g. ~/.vellum/workspace/data/db/assistant.db). */
  dbPath: string;
  /** Path to the config file (e.g. ~/.vellum/workspace/config.json). */
  configPath: string;
  /** Source identifier. Defaults to "runtime-export". */
  source?: string;
  /** Human-readable description. */
  description?: string;
  /** Absolute path to trust.json. If provided and the file exists, it is included in the archive. */
  trustPath?: string;
  /** Absolute path to the workspace skills directory. If provided and exists, all non-binary files are included. */
  skillsDir?: string;
  /** Absolute path to the workspace directory. If provided and exists, prompt files (IDENTITY.md, SOUL.md, USER.md, UPDATES.md) are included. */
  workspaceDir?: string;
  /** Absolute path to the workspace hooks directory. If provided and exists, all hook files are included. */
  hooksDir?: string;
  /**
   * Optional callback to checkpoint the WAL before reading the database file.
   * In WAL mode, committed rows may live in the -wal file and not yet be
   * flushed to the main .db file. Callers should pass a function that runs
   * PRAGMA wal_checkpoint(TRUNCATE) on the live database connection.
   */
  checkpoint?: () => void;
}

/**
 * Build a .vbundle archive populated with real assistant data.
 *
 * Reads the actual SQLite database (which contains all conversations,
 * messages, memory segments, embeddings, and other assistant state) and
 * the config file from disk. Returns a complete, self-validating archive
 * ready for migration import.
 *
 * Falls back gracefully: if the database does not exist, an empty file is
 * included. If the config does not exist, an empty JSON object is used.
 */
export function buildExportVBundle(
  options: BuildExportVBundleOptions,
): BuildVBundleResult {
  const { dbPath, configPath, source, description, checkpoint, trustPath, skillsDir, workspaceDir, hooksDir } = options;

  // Flush WAL to the main database file before reading so the export
  // captures all committed rows (SQLite WAL mode keeps recent writes
  // in a separate -wal file until checkpoint).
  if (checkpoint) {
    checkpoint();
  }

  const dbData = existsSync(dbPath)
    ? new Uint8Array(readFileSync(dbPath))
    : new Uint8Array(0);

  // Read the config file (settings, provider config, feature flags, etc.).
  const configData = existsSync(configPath)
    ? new Uint8Array(readFileSync(configPath))
    : new TextEncoder().encode("{}");

  const files: VBundleFileEntry[] = [
    { path: "data/db/assistant.db", data: dbData },
    { path: "config/settings.json", data: configData },
  ];

  // Include trust rules if the file exists.
  if (trustPath && existsSync(trustPath)) {
    const trustData = new Uint8Array(readFileSync(trustPath));
    files.push({ path: "trust/trust.json", data: trustData });
  }

  // Include workspace skills if the path exists and is a directory.
  if (skillsDir && existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
    files.push(...walkDirectory(skillsDir, "skills"));
  }

  // Include workspace prompt files if the directory exists.
  if (workspaceDir && existsSync(workspaceDir)) {
    const promptFiles = ["IDENTITY.md", "SOUL.md", "USER.md", "UPDATES.md"];
    for (const filename of promptFiles) {
      const filePath = join(workspaceDir, filename);
      if (existsSync(filePath)) {
        const data = new Uint8Array(readFileSync(filePath));
        files.push({ path: `prompts/${filename}`, data });
      }
    }
  }

  // Include workspace hooks if the directory exists.
  if (hooksDir && existsSync(hooksDir)) {
    files.push(...walkDirectory(hooksDir, "hooks"));
  }

  return buildVBundle({
    files,
    source: source ?? "runtime-export",
    description: description ?? "Runtime export bundle",
  });
}
