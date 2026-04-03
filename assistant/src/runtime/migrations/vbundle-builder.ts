/**
 * Builds .vbundle archive files for migration export.
 *
 * A .vbundle is a gzip-compressed tar archive containing:
 * - manifest.json: metadata with schema_version, checksums, and bundle info
 * - workspace/: the entire ~/.vellum/workspace/ directory tree (DB, config,
 *   skills, hooks, prompts, attachments, etc.) — excluding large/regenerable
 *   dirs (embedding-models/, data/qdrant/)
 * - trust/trust.json: trust rules (optional, lives in protected/ outside workspace)
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";

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

interface FileMetadata {
  archivePath: string;
  diskPath: string;
  size: number;
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

interface WalkDirectoryOptions {
  /** Include binary files (files containing null bytes). Default: false. */
  includeBinary?: boolean;
  /** Directory names to skip (matched against immediate child name). */
  skipDirs?: string[];
}

/**
 * Recursively walk a directory and return all non-symlink files as
 * VBundleFileEntry objects with paths prefixed by `archivePrefix`.
 *
 * By default, binary files (detected via null-byte heuristic in the first
 * 8 KB) are skipped. Pass `includeBinary: true` to include them.
 */
function walkDirectory(
  dir: string,
  archivePrefix: string,
  options: WalkDirectoryOptions = {},
): VBundleFileEntry[] {
  const { includeBinary = false, skipDirs = [] } = options;
  const entries: VBundleFileEntry[] = [];

  function walk(currentDir: string): void {
    const dirEntries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const fullPath = join(currentDir, entry.name);

      // Skip symlinks
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        // Check skip list against the relative path from the walk root
        const relDir = relative(dir, fullPath);
        if (skipDirs.some((s) => relDir === s || relDir.startsWith(s + "/"))) {
          continue;
        }
        walk(fullPath);
      } else if (stat.isFile()) {
        // Skip SQLite auxiliary files — these are ephemeral and race-prone
        // with the live DB connection. The WAL is checkpointed before the
        // walk, so the main .db file has all committed rows.
        if (
          entry.name.endsWith(".db-wal") ||
          entry.name.endsWith(".db-shm") ||
          entry.name.endsWith(".db-journal")
        ) {
          continue;
        }

        const data = new Uint8Array(readFileSync(fullPath));

        // Skip binary files unless explicitly included
        if (!includeBinary) {
          const checkLength = Math.min(data.length, 8192);
          let isBinary = false;
          for (let i = 0; i < checkLength; i++) {
            if (data[i] === 0) {
              isBinary = true;
              break;
            }
          }
          if (isBinary) continue;
        }

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
  /** Source identifier. Defaults to "runtime-export". */
  source?: string;
  /** Human-readable description. */
  description?: string;
  /** Absolute path to trust.json. If provided and the file exists, it is included in the archive. */
  trustPath?: string;
  /**
   * Absolute path to the hooks directory. Previously hooks lived outside the
   * workspace at ~/.vellum/hooks/ and needed explicit inclusion. Now hooks
   * live under workspace (~/.vellum/workspace/hooks/) and are included in
   * the workspace walk. Only pass this for backward-compat scenarios where
   * hooks are still outside the workspace; otherwise omit to avoid double
   * export. Included in the archive under the "hooks/" prefix.
   */
  hooksDir?: string;
  /**
   * Absolute path to the workspace directory (~/.vellum/workspace/).
   * When provided and exists, the entire directory tree is walked and
   * included in the archive under the "workspace/" prefix, skipping
   * large/regenerable dirs (embedding-models/, data/qdrant/).
   * Binary files (SQLite DB, attachments) are included.
   */
  workspaceDir?: string;
  /**
   * Optional callback to checkpoint the WAL before reading the database file.
   * In WAL mode, committed rows may live in the -wal file and not yet be
   * flushed to the main .db file. Callers should pass a function that runs
   * PRAGMA wal_checkpoint(TRUNCATE) on the live database connection.
   * Called before the workspace walk so the DB file is up to date.
   */
  checkpoint?: () => void;
}

/**
 * Build a .vbundle archive populated with real assistant data.
 *
 * Walks the entire workspace directory (~/.vellum/workspace/) and includes
 * all files in the archive, skipping only large/regenerable directories
 * (embedding-models/, data/qdrant/). Binary files (SQLite DB, attachments)
 * are included. Trust rules (in protected/, outside workspace) are handled
 * separately.
 *
 * The WAL is checkpointed before the walk so the exported DB file contains
 * all committed rows.
 */
export function buildExportVBundle(
  options: BuildExportVBundleOptions,
): BuildVBundleResult {
  const { source, description, checkpoint, trustPath, workspaceDir, hooksDir } =
    options;

  // Flush WAL to the main database file before reading so the export
  // captures all committed rows (SQLite WAL mode keeps recent writes
  // in a separate -wal file until checkpoint).
  if (checkpoint) {
    checkpoint();
  }

  const files: VBundleFileEntry[] = [];

  // Walk the entire workspace directory, including binary files (DB,
  // attachments) but skipping large/regenerable subdirectories.
  if (
    workspaceDir &&
    existsSync(workspaceDir) &&
    lstatSync(workspaceDir).isDirectory()
  ) {
    files.push(
      ...walkDirectory(workspaceDir, "workspace", {
        includeBinary: true,
        skipDirs: ["embedding-models", "data/qdrant", "signals", "deprecated"],
      }),
    );
  }

  // Include hooks directory if it exists (lives at ~/.vellum/hooks/, outside workspace).
  if (hooksDir && existsSync(hooksDir) && lstatSync(hooksDir).isDirectory()) {
    files.push(...walkDirectory(hooksDir, "hooks"));
  }

  // Include trust rules if the file exists (lives in protected/, outside workspace).
  if (trustPath && existsSync(trustPath)) {
    const trustData = new Uint8Array(readFileSync(trustPath));
    files.push({ path: "trust/trust.json", data: trustData });
  }

  return buildVBundle({
    files,
    source: source ?? "runtime-export",
    description: description ?? "Runtime export bundle",
  });
}

// ---------------------------------------------------------------------------
// Streaming export builder — two-pass approach for bounded memory usage
// ---------------------------------------------------------------------------

/**
 * Walk a directory tree and collect file metadata (paths + sizes) without
 * reading file contents into memory. Uses the same filtering logic as
 * `walkDirectory` (symlink skip, SQLite auxiliary skip, binary detection,
 * skip dirs).
 */
function walkDirectoryForMetadata(
  dir: string,
  archivePrefix: string,
  options: WalkDirectoryOptions = {},
): FileMetadata[] {
  const { includeBinary = false, skipDirs = [] } = options;
  const entries: FileMetadata[] = [];

  function walk(currentDir: string): void {
    const dirEntries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const fullPath = join(currentDir, entry.name);

      // Skip symlinks
      const fileStat = lstatSync(fullPath);
      if (fileStat.isSymbolicLink()) continue;

      if (fileStat.isDirectory()) {
        // Check skip list against the relative path from the walk root
        const relDir = relative(dir, fullPath);
        if (skipDirs.some((s) => relDir === s || relDir.startsWith(s + "/"))) {
          continue;
        }
        walk(fullPath);
      } else if (fileStat.isFile()) {
        // Skip SQLite auxiliary files — these are ephemeral and race-prone
        if (
          entry.name.endsWith(".db-wal") ||
          entry.name.endsWith(".db-shm") ||
          entry.name.endsWith(".db-journal")
        ) {
          continue;
        }

        // Skip binary files unless explicitly included
        if (!includeBinary) {
          // Read only the first 8 KB to check for null bytes
          const checkLength = Math.min(fileStat.size, 8192);
          if (checkLength > 0) {
            const buf = Buffer.alloc(checkLength);
            const fd = openSync(fullPath, "r");
            try {
              readSync(fd, buf, 0, checkLength, 0);
            } finally {
              closeSync(fd);
            }
            let isBinary = false;
            for (let i = 0; i < checkLength; i++) {
              if (buf[i] === 0) {
                isBinary = true;
                break;
              }
            }
            if (isBinary) continue;
          }
        }

        const relativePath = relative(dir, fullPath);
        entries.push({
          archivePath: `${archivePrefix}/${relativePath}`,
          diskPath: fullPath,
          size: fileStat.size,
        });
      }
    }
  }

  walk(dir);
  return entries;
}

/**
 * Compute SHA-256 hex digest of a file by streaming — never buffers the
 * entire file in memory. When `size` is provided, only hashes the first
 * `size` bytes to match what will be archived in the tar entry.
 */
async function computeFileSha256(
  filePath: string,
  size?: number,
): Promise<string> {
  const hash = createHash("sha256");
  if (size === 0) return hash.digest("hex");
  const streamOpts =
    size !== undefined ? { start: 0, end: size - 1 } : undefined;
  const stream = createReadStream(filePath, streamOpts);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * Create just the 512-byte tar header block for a regular file entry.
 * Extracted from `createTarEntry` logic — does NOT include data or padding.
 */
function createTarHeaderBlock(name: string, size: number): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);

  const header = new Uint8Array(BLOCK_SIZE);

  // File name (0-99) — truncated if >100 bytes
  header.set(nameBytes.subarray(0, 100), 0);

  // File mode (100-107): 0644
  writeOctal(header, 100, 8, 0o644);

  // Owner ID (108-115)
  writeOctal(header, 108, 8, 0);

  // Group ID (116-123)
  writeOctal(header, 116, 8, 0);

  // File size (124-135)
  writeOctal(header, 124, 12, size);

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

  return header;
}

/**
 * If name exceeds 100 bytes, returns the PAX extended header entry
 * concatenated with the regular header block. Otherwise returns just
 * the header block.
 */
function createPaxAndHeaderBlocks(name: string, size: number): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const needsPax = nameBytes.length > 100;

  const header = createTarHeaderBlock(name, size);

  if (needsPax) {
    const paxEntry = createPaxPathEntry(name);
    const result = new Uint8Array(paxEntry.length + header.length);
    result.set(paxEntry, 0);
    result.set(header, paxEntry.length);
    return result;
  }

  return header;
}

/**
 * Returns zero-filled padding bytes to align data to the tar block boundary.
 */
function tarPaddingBytes(dataSize: number): Uint8Array {
  const remainder = dataSize % BLOCK_SIZE;
  if (remainder === 0) return new Uint8Array(0);
  return new Uint8Array(BLOCK_SIZE - remainder);
}

/**
 * Async generator that yields raw tar bytes in order:
 * manifest entry, then each file entry, then end-of-archive marker.
 * Each file is streamed from disk — never fully buffered in memory.
 */
async function* generateTarStream(
  manifestJson: Uint8Array,
  files: FileMetadata[],
): AsyncGenerator<Uint8Array> {
  // Manifest entry
  yield createPaxAndHeaderBlocks("manifest.json", manifestJson.length);
  yield manifestJson;
  yield tarPaddingBytes(manifestJson.length);

  // File entries
  for (const file of files) {
    yield createPaxAndHeaderBlocks(file.archivePath, file.size);

    // Stream exactly file.size bytes from disk. Capping the read at the
    // declared size keeps the tar structure valid even if the file grows
    // between passes (common for log files on active assistants). If the
    // file shrinks below the declared size, zero-pad to maintain block
    // alignment. The WAL checkpoint before export is the primary
    // consistency mechanism for the database.
    let bytesWritten = 0;
    if (file.size > 0) {
      try {
        const stream = createReadStream(file.diskPath, {
          start: 0,
          end: file.size - 1,
        });
        for await (const chunk of stream) {
          const data =
            chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          bytesWritten += data.length;
          yield data;
        }
      } catch {
        // File was deleted or rotated between passes — emit zeros for
        // the full declared size so the tar structure stays valid
      }
    }

    // If the file shrank, pad with zeros in bounded chunks to reach
    // the declared size without a large single allocation
    let remaining = file.size - bytesWritten;
    while (remaining > 0) {
      const chunkSize = Math.min(remaining, 65536);
      yield new Uint8Array(chunkSize);
      remaining -= chunkSize;
    }

    yield tarPaddingBytes(file.size);
  }

  // End-of-archive: two zero blocks
  yield new Uint8Array(BLOCK_SIZE * 2);
}

// ---------------------------------------------------------------------------
// Streaming export result type
// ---------------------------------------------------------------------------

export interface StreamExportVBundleResult {
  tempPath: string;
  size: number;
  manifest: ManifestType;
  cleanup: () => Promise<void>;
}

/**
 * Build a .vbundle archive using a streaming two-pass approach that keeps
 * peak memory usage bounded to ~1 MB regardless of workspace size.
 *
 * Pass 1: Walk directory metadata and compute SHA-256 checksums without
 *         loading file contents into memory (builds manifest).
 * Pass 2: Stream tar entries through gzip into a temp file on disk.
 *
 * Returns a result with the temp file path, size, manifest, and a cleanup
 * function to remove the temp file when done.
 */
export async function streamExportVBundle(
  options: BuildExportVBundleOptions,
): Promise<StreamExportVBundleResult> {
  const { source, description, checkpoint, trustPath, workspaceDir, hooksDir } =
    options;

  // Flush WAL to the main database file before reading
  if (checkpoint) {
    checkpoint();
  }

  const allFileMetadata: FileMetadata[] = [];

  // Walk the entire workspace directory, including binary files
  if (
    workspaceDir &&
    existsSync(workspaceDir) &&
    lstatSync(workspaceDir).isDirectory()
  ) {
    allFileMetadata.push(
      ...walkDirectoryForMetadata(workspaceDir, "workspace", {
        includeBinary: true,
        skipDirs: ["embedding-models", "data/qdrant", "signals", "deprecated"],
      }),
    );
  }

  // Include hooks directory if it exists
  if (hooksDir && existsSync(hooksDir) && lstatSync(hooksDir).isDirectory()) {
    allFileMetadata.push(...walkDirectoryForMetadata(hooksDir, "hooks"));
  }

  // Include trust rules if the file exists
  if (trustPath && existsSync(trustPath)) {
    const trustStat = lstatSync(trustPath);
    if (trustStat.isFile()) {
      allFileMetadata.push({
        archivePath: "trust/trust.json",
        diskPath: trustPath,
        size: trustStat.size,
      });
    }
  }

  // ------------------------------------------------------------------
  // Pass 1: Compute SHA-256 checksums to build the manifest
  // ------------------------------------------------------------------

  const fileEntries: ManifestFileEntryType[] = [];
  for (const file of allFileMetadata) {
    const sha256 = await computeFileSha256(file.diskPath, file.size);
    fileEntries.push({
      path: file.archivePath,
      sha256,
      size: file.size,
    });
  }

  const manifestWithoutChecksum = {
    schema_version: "1.0",
    created_at: new Date().toISOString(),
    source: source ?? "runtime-export",
    description: description ?? "Runtime export bundle",
    files: fileEntries,
  };

  const manifestSha256 = sha256Hex(canonicalizeJson(manifestWithoutChecksum));
  const manifest: ManifestType = {
    ...manifestWithoutChecksum,
    manifest_sha256: manifestSha256,
  };

  const manifestData = new TextEncoder().encode(JSON.stringify(manifest));

  // ------------------------------------------------------------------
  // Pass 2: Stream tar through gzip into a temp file
  // ------------------------------------------------------------------

  const tempPath = join(tmpdir(), `vbundle-export-${randomUUID()}.tmp`);

  const tarGenerator = generateTarStream(manifestData, allFileMetadata);
  const tarReadable = Readable.from(tarGenerator);
  const gzipStream = createGzip();
  const writeStream = createWriteStream(tempPath, { mode: 0o600 });

  try {
    await pipeline(tarReadable, gzipStream, writeStream);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }

  const tempStat = await stat(tempPath);

  const cleanup = async () => {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore errors during cleanup
    }
  };

  return { tempPath, size: tempStat.size, manifest, cleanup };
}
