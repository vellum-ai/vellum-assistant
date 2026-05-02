/**
 * Builds .vbundle archive files for migration export.
 *
 * A .vbundle is a gzip-compressed tar archive containing:
 * - manifest.json: metadata with schema_version, checksums, and bundle info
 * - workspace/: the entire ~/.vellum/workspace/ directory tree (DB, config,
 *   skills, prompts, attachments, etc.) — excluding large/regenerable
 *   dirs (embedding-models/, data/qdrant/)
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
  realpathSync,
} from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";

import { sanitizeConfigForTransfer } from "../../config/sanitize-for-transfer.js";
import { getLogger } from "../../util/logger.js";
import type { VBundleOriginMode } from "./origin-mode.js";
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
  /** When set, `data` is ignored: the entry is emitted as a tar typeflag-2 (symlink) record with empty body, and `linkTarget` is the symlink target encoded relative to the symlink's own directory inside the archive. */
  linkTarget?: string;
}

/** v1 manifest `assistant` block. */
export interface VBundleAssistantInfo {
  id: string;
  name: string;
  runtime_version: string;
}

/** v1 manifest `origin` block. */
export interface VBundleOriginInfo {
  mode: VBundleOriginMode;
  platform_version?: string;
  hostname?: string;
}

/** v1 manifest `compatibility` block. */
export interface VBundleCompatibility {
  min_runtime_version: string;
  max_runtime_version: string | null;
}

/** v1 manifest `export_options` block. */
export interface VBundleExportOptions {
  include_logs: boolean;
  include_browser_state: boolean;
  include_memory_vectors: boolean;
}

export interface BuildVBundleOptions {
  /** Files to include in the archive. Must include data/db/assistant.db. */
  files: VBundleFileEntry[];
  /** Identity of the assistant that produced this bundle. */
  assistant: VBundleAssistantInfo;
  /** Where this bundle was produced. */
  origin: VBundleOriginInfo;
  /** Runtime-version compatibility window for importers. */
  compatibility: VBundleCompatibility;
  /** Which optional bundle contents this export carries. */
  exportOptions: VBundleExportOptions;
  /**
   * Whether secrets were stripped from the bundle before archiving.
   * Required at the type level — defaulting silently is exactly how the
   * prior schema mismatch went unnoticed.
   */
  secretsRedacted: boolean;
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

/** In-memory entry for data not backed by a file on disk (e.g. credentials). */
interface InMemoryEntry {
  archivePath: string;
  data: Uint8Array;
  size: number;
}

/** Symlink entry — emitted as a tar typeflag-2 record with empty body. */
interface SymlinkMetadata {
  archivePath: string;
  linkTarget: string;
  size: 0;
}

/** Union of disk-backed, in-memory, and symlink tar stream entries. */
type TarStreamEntry = FileMetadata | InMemoryEntry | SymlinkMetadata;

function isInMemoryEntry(entry: TarStreamEntry): entry is InMemoryEntry {
  return "data" in entry;
}

function isSymlinkEntry(entry: TarStreamEntry): entry is SymlinkMetadata {
  return "linkTarget" in entry;
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

function createTarEntry(
  name: string,
  data: Uint8Array,
  linkTarget?: string,
): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);

  // If the name exceeds 100 bytes, emit a PAX extended header first
  // so that the full path is preserved in the archive.
  const needsPax = nameBytes.length > 100;
  const paxEntry = needsPax ? createPaxPathEntry(name) : null;

  const isSymlink = linkTarget !== undefined;
  const linkTargetBytes = isSymlink ? encoder.encode(linkTarget) : null;
  if (linkTargetBytes && linkTargetBytes.length > 100) {
    throw new Error(
      `Symlink target "${linkTarget}" is ${linkTargetBytes.length} bytes, exceeding the ustar linkname-field 100-byte limit. The walker should guard against this case before calling createTarEntry.`,
    );
  }

  const header = new Uint8Array(BLOCK_SIZE);

  // File name (0-99) — truncated if >100 bytes; PAX header carries the full name
  header.set(nameBytes.subarray(0, 100), 0);

  // File mode (100-107): 0644
  writeOctal(header, 100, 8, 0o644);

  // Owner ID (108-115)
  writeOctal(header, 108, 8, 0);

  // Group ID (116-123)
  writeOctal(header, 116, 8, 0);

  // File size (124-135) — symlink entries always carry size 0
  writeOctal(header, 124, 12, isSymlink ? 0 : data.length);

  // Modification time (136-147)
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));

  // Type flag (156): regular file ("0") or symlink ("2")
  header[156] = (isSymlink ? "2" : "0").charCodeAt(0);

  // Linkname (157-256) — only set for symlinks; null-padded by default
  if (linkTargetBytes) {
    header.set(linkTargetBytes, 157);
  }

  // USTAR magic (257-262)
  const magic = encoder.encode("ustar\0");
  header.set(magic, 257);

  // USTAR version (263-264)
  header[263] = "0".charCodeAt(0);
  header[264] = "0".charCodeAt(0);

  // Compute and write checksum (148-155) — must be last so the linkname
  // (and every other field) contributes to the sum.
  const checksum = computeHeaderChecksum(header);
  writeOctal(header, 148, 7, checksum);
  header[155] = 0x20; // trailing space

  // Symlink entries are header-only — no body, no padding.
  const fileEntry = isSymlink
    ? header
    : (() => {
        const paddedData = padToBlock(data);
        const combined = new Uint8Array(header.length + paddedData.length);
        combined.set(header, 0);
        combined.set(paddedData, header.length);
        return combined;
      })();

  if (paxEntry) {
    const result = new Uint8Array(paxEntry.length + fileEntry.length);
    result.set(paxEntry, 0);
    result.set(fileEntry, paxEntry.length);
    return result;
  }

  return fileEntry;
}

function createTarArchive(
  entries: Array<{ name: string; data: Uint8Array; linkTarget?: string }>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(createTarEntry(entry.name, entry.data, entry.linkTarget));
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
 * Build the v1 manifest object and its serialized JSON bytes for a vbundle.
 *
 * Shared by the buffered (`buildVBundle`) and streaming
 * (`streamExportVBundle`) emit sites so the manifest shape and self-checksum
 * computation live in exactly one place.
 *
 * The checksum is computed over the canonicalized manifest with the
 * `checksum` field set to the empty string (per the schema spec) — both
 * producers and the validator agree on this exact wire shape.
 */
function buildManifestObject(input: {
  contents: ManifestFileEntryType[];
  assistant: VBundleAssistantInfo;
  origin: VBundleOriginInfo;
  compatibility: VBundleCompatibility;
  exportOptions: VBundleExportOptions;
  secretsRedacted: boolean;
  now: Date;
}): { manifest: ManifestType; manifestData: Uint8Array } {
  const manifestWithEmptyChecksum = {
    schema_version: 1 as const,
    bundle_id: randomUUID(),
    created_at: input.now.toISOString(),
    assistant: input.assistant,
    origin: input.origin,
    compatibility: input.compatibility,
    contents: input.contents,
    checksum: "",
    secrets_redacted: input.secretsRedacted,
    export_options: input.exportOptions,
  };
  const checksum = sha256Hex(canonicalizeJson(manifestWithEmptyChecksum));
  const manifest: ManifestType = { ...manifestWithEmptyChecksum, checksum };
  const manifestData = new TextEncoder().encode(JSON.stringify(manifest));
  return { manifest, manifestData };
}

/**
 * Build a .vbundle archive from the given files and metadata.
 *
 * Generates a valid manifest with SHA-256 checksums for all files and
 * a self-referencing `checksum`. The archive is returned
 * as gzip-compressed tar bytes.
 */
export function buildVBundle(options: BuildVBundleOptions): BuildVBundleResult {
  const {
    files,
    assistant,
    origin,
    compatibility,
    exportOptions,
    secretsRedacted,
  } = options;

  // Build file entries for the manifest. Symlink entries hash the link target
  // string (not the empty data buffer) and declare size_bytes: 0.
  const fileEntries: ManifestFileEntryType[] = files.map((f) =>
    f.linkTarget !== undefined
      ? {
          path: f.path,
          sha256: sha256Hex(f.linkTarget),
          size_bytes: 0,
          link_target: f.linkTarget,
        }
      : {
          path: f.path,
          sha256: sha256Hex(f.data),
          size_bytes: f.data.length,
        },
  );

  const { manifest, manifestData } = buildManifestObject({
    contents: fileEntries,
    assistant,
    origin,
    compatibility,
    exportOptions,
    secretsRedacted,
    now: new Date(),
  });

  // Build tar entries: manifest first, then all files. Symlink entries forward
  // `linkTarget` so createTarEntry emits a typeflag-2 header; `data` is unused
  // in that branch but must still be a valid Uint8Array.
  const tarEntries = [
    { name: "manifest.json", data: manifestData },
    ...files.map((f) =>
      f.linkTarget !== undefined
        ? { name: f.path, data: new Uint8Array(0), linkTarget: f.linkTarget }
        : { name: f.path, data: f.data },
    ),
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
 * Resolve and classify a symlink encountered during a walk.
 *
 * Returns one of:
 *   { kind: "class1", linkTarget } — emit as a tar typeflag-2 entry whose
 *     `linkname` field holds `linkTarget` (the symlink target encoded as a
 *     POSIX path relative to the symlink's own directory).
 *   { kind: "drop", reason }       — drop the symlink. Reasons cover broken
 *     links, targets outside the workspace (class 2), targets inside a
 *     skipped directory (class 3), directory targets (out of scope), and
 *     link targets whose UTF-8 encoding exceeds the 100-byte ustar
 *     `linkname` field limit.
 */
type SymlinkClassification =
  | { kind: "class1"; linkTarget: string }
  | { kind: "drop"; reason: string };

function classifySymlink(args: {
  fullPath: string;
  walkRoot: string;
  skipDirs: readonly string[];
}): SymlinkClassification {
  const { fullPath, walkRoot, skipDirs } = args;

  let absoluteTarget: string;
  try {
    absoluteTarget = realpathSync(fullPath);
  } catch {
    return { kind: "drop", reason: "broken symlink (realpath failed)" };
  }

  let targetStat;
  try {
    targetStat = lstatSync(absoluteTarget);
  } catch {
    return { kind: "drop", reason: "broken symlink (target stat failed)" };
  }
  if (!targetStat.isFile()) {
    return { kind: "drop", reason: "target is not a regular file" };
  }

  let dirAbs: string;
  try {
    dirAbs = realpathSync(walkRoot);
  } catch {
    dirAbs = resolve(walkRoot);
  }
  const targetAbs = resolve(absoluteTarget);
  const insideWorkspace =
    targetAbs === dirAbs || targetAbs.startsWith(dirAbs + sep);
  if (!insideWorkspace) {
    return { kind: "drop", reason: "target outside workspace" };
  }

  const targetRelToWorkspace = relative(dirAbs, targetAbs);
  if (
    skipDirs.some(
      (s) =>
        targetRelToWorkspace === s || targetRelToWorkspace.startsWith(s + "/"),
    )
  ) {
    return { kind: "drop", reason: "target inside skipDir" };
  }

  // Canonicalize the symlink's parent directory so the relative linkTarget
  // computation lines up with `absoluteTarget` (which is canonical from
  // realpathSync). On macOS, walking through /var/folders/... and resolving
  // the target through /private/var/folders/... would otherwise produce a
  // long ../../../private/... path that exceeds the 100-byte ustar limit.
  let parentAbs: string;
  try {
    parentAbs = realpathSync(dirname(fullPath));
  } catch {
    parentAbs = resolve(dirname(fullPath));
  }
  const linkTarget = relative(parentAbs, absoluteTarget);
  if (new TextEncoder().encode(linkTarget).length > 100) {
    return {
      kind: "drop",
      reason: "encoded link target exceeds 100-byte ustar limit",
    };
  }

  return { kind: "class1", linkTarget };
}

/**
 * Recursively walk a directory and return all regular files (and bundleable
 * symlinks) as VBundleFileEntry objects with paths prefixed by
 * `archivePrefix`. Symlinks that resolve to a regular file inside the walk
 * root and outside any skipDir are emitted as typeflag-2 entries (data
 * empty, `linkTarget` populated). All other symlinks (broken, directory
 * target, target outside workspace, target inside skipDir, encoded
 * linkTarget over 100 bytes) are reported via the returned `droppedSymlinks`
 * array as workspace-relative paths of the symlink itself.
 *
 * By default, binary files (detected via null-byte heuristic in the first
 * 8 KB) are skipped. Pass `includeBinary: true` to include them.
 */
export function walkDirectory(
  dir: string,
  archivePrefix: string,
  options: WalkDirectoryOptions = {},
): { files: VBundleFileEntry[]; droppedSymlinks: string[] } {
  const { includeBinary = false, skipDirs = [] } = options;
  const entries: VBundleFileEntry[] = [];
  const droppedSymlinks: string[] = [];

  function walk(currentDir: string): void {
    const dirEntries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const fullPath = join(currentDir, entry.name);

      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        const classification = classifySymlink({
          fullPath,
          walkRoot: dir,
          skipDirs,
        });
        if (classification.kind === "class1") {
          entries.push({
            path: `${archivePrefix}/${relative(dir, fullPath)}`,
            data: new Uint8Array(0),
            linkTarget: classification.linkTarget,
          });
        } else {
          droppedSymlinks.push(relative(dir, fullPath));
        }
        continue;
      }

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
  return { files: entries, droppedSymlinks };
}

// ---------------------------------------------------------------------------
// Export builder — reads real data from disk
// ---------------------------------------------------------------------------

export interface BuildExportVBundleOptions {
  /** Identity of the assistant that produced this bundle. */
  assistant: VBundleAssistantInfo;
  /** Where this bundle was produced. */
  origin: VBundleOriginInfo;
  /** Runtime-version compatibility window for importers. */
  compatibility: VBundleCompatibility;
  /** Which optional bundle contents this export carries. */
  exportOptions: VBundleExportOptions;
  /** Whether secrets were stripped from the bundle before archiving. */
  secretsRedacted: boolean;
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
  /** Optional credential entries to include in the archive under credentials/ prefix. */
  credentials?: Array<{ account: string; value: string }>;
}

/**
 * Build a .vbundle archive populated with real assistant data.
 *
 * Walks the entire workspace directory (~/.vellum/workspace/) and includes
 * all files in the archive, skipping only large/regenerable directories
 * (embedding-models/, data/qdrant/). Binary files (SQLite DB, attachments)
 * are included.
 *
 * The WAL is checkpointed before the walk so the exported DB file contains
 * all committed rows.
 */
export function buildExportVBundle(
  options: BuildExportVBundleOptions,
): BuildVBundleResult {
  const {
    assistant,
    origin,
    compatibility,
    exportOptions,
    secretsRedacted,
    checkpoint,
    workspaceDir,
    credentials,
  } = options;

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
    const { files: walkedFiles, droppedSymlinks } = walkDirectory(
      workspaceDir,
      "workspace",
      {
        includeBinary: true,
        skipDirs: ["embedding-models", "data/qdrant", "signals", "deprecated"],
      },
    );
    files.push(...walkedFiles);
    if (droppedSymlinks.length > 0) {
      getLogger("vbundle-builder").warn(
        { count: droppedSymlinks.length, paths: droppedSymlinks },
        `Dropped ${droppedSymlinks.length} symlinks pointing outside workspace or into skipped directories`,
      );
    }
  }

  // Sanitize workspace/config.json to strip environment-specific fields
  const configEntry = files.find((f) => f.path === "workspace/config.json");
  if (configEntry) {
    const configJson = new TextDecoder().decode(configEntry.data);
    const sanitized = sanitizeConfigForTransfer(configJson);
    configEntry.data = new TextEncoder().encode(sanitized);
  }

  // Include credential entries if provided
  if (credentials?.length) {
    for (const { account, value } of credentials) {
      const data = new TextEncoder().encode(value);
      files.push({ path: `credentials/${account}`, data });
    }
  }

  return buildVBundle({
    files,
    assistant,
    origin,
    compatibility,
    exportOptions,
    secretsRedacted,
  });
}

// ---------------------------------------------------------------------------
// Streaming export builder — two-pass approach for bounded memory usage
// ---------------------------------------------------------------------------

/**
 * Walk a directory tree and collect file metadata (paths + sizes) without
 * reading file contents into memory. Mirrors `walkDirectory`'s filtering
 * logic (SQLite auxiliary skip, binary detection, skipDirs) and symlink
 * classification — bundleable symlinks are emitted as `SymlinkMetadata`
 * entries; non-bundleable symlinks are reported via `droppedSymlinks`.
 */
export function walkDirectoryForMetadata(
  dir: string,
  archivePrefix: string,
  options: WalkDirectoryOptions = {},
): {
  files: FileMetadata[];
  symlinks: SymlinkMetadata[];
  droppedSymlinks: string[];
} {
  const { includeBinary = false, skipDirs = [] } = options;
  const entries: FileMetadata[] = [];
  const symlinks: SymlinkMetadata[] = [];
  const droppedSymlinks: string[] = [];

  function walk(currentDir: string): void {
    const dirEntries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const fullPath = join(currentDir, entry.name);

      const fileStat = lstatSync(fullPath);
      if (fileStat.isSymbolicLink()) {
        const classification = classifySymlink({
          fullPath,
          walkRoot: dir,
          skipDirs,
        });
        if (classification.kind === "class1") {
          symlinks.push({
            archivePath: `${archivePrefix}/${relative(dir, fullPath)}`,
            linkTarget: classification.linkTarget,
            size: 0,
          });
        } else {
          droppedSymlinks.push(relative(dir, fullPath));
        }
        continue;
      }

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
  return { files: entries, symlinks, droppedSymlinks };
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
 *
 * When `linkTarget` is provided, the header is emitted as a tar typeflag-2
 * (symlink) record: typeflag is "2", the link target is written into the
 * `linkname` field (header[157..256], 100-byte limit), and `size` is forced
 * to 0 in the header field. Caller is responsible for not yielding any body
 * or padding bytes for symlink entries.
 */
function createTarHeaderBlock(
  name: string,
  size: number,
  linkTarget?: string,
): Uint8Array {
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

  // File size (124-135) — symlink entries always declare size=0
  writeOctal(header, 124, 12, linkTarget !== undefined ? 0 : size);

  // Modification time (136-147)
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));

  // Type flag (156): regular file ("0") or symlink ("2")
  header[156] =
    linkTarget !== undefined ? "2".charCodeAt(0) : "0".charCodeAt(0);

  // Linkname (157-256, 100 bytes) — only set for symlink entries
  if (linkTarget !== undefined) {
    const linkBytes = encoder.encode(linkTarget);
    if (linkBytes.length > 100) {
      throw new Error(
        `symlink target exceeds 100-byte ustar linkname limit (${linkBytes.length} bytes): ${linkTarget}`,
      );
    }
    header.set(linkBytes, 157);
  }

  // USTAR magic (257-262)
  const magic = encoder.encode("ustar\0");
  header.set(magic, 257);

  // USTAR version (263-264)
  header[263] = "0".charCodeAt(0);
  header[264] = "0".charCodeAt(0);

  // Compute and write checksum (148-155). Must run AFTER linkname is set
  // so the checksum covers the symlink target bytes.
  const checksum = computeHeaderChecksum(header);
  writeOctal(header, 148, 7, checksum);
  header[155] = 0x20; // trailing space

  return header;
}

/**
 * If name exceeds 100 bytes, returns the PAX extended header entry
 * concatenated with the regular header block. Otherwise returns just
 * the header block.
 *
 * `linkTarget` is forwarded to `createTarHeaderBlock` so symlink entries
 * still get a PAX path header for long names while emitting a typeflag-2
 * ustar block.
 */
function createPaxAndHeaderBlocks(
  name: string,
  size: number,
  linkTarget?: string,
): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const needsPax = nameBytes.length > 100;

  const header = createTarHeaderBlock(name, size, linkTarget);

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
  files: TarStreamEntry[],
): AsyncGenerator<Uint8Array> {
  // Manifest entry
  yield createPaxAndHeaderBlocks("manifest.json", manifestJson.length);
  yield manifestJson;
  yield tarPaddingBytes(manifestJson.length);

  // File entries
  for (const file of files) {
    if (isSymlinkEntry(file)) {
      // Symlink entry: typeflag-2 header carries the linkname; no body, no
      // padding. Skip the entrySize/body/padding logic entirely so the
      // surrounding stream stays block-aligned.
      yield createPaxAndHeaderBlocks(file.archivePath, 0, file.linkTarget);
      continue;
    }

    const entrySize = file.size;
    yield createPaxAndHeaderBlocks(file.archivePath, entrySize);

    if (isInMemoryEntry(file)) {
      // In-memory entry — yield data directly
      if (file.size > 0) {
        yield file.data;
      }
    } else {
      // Disk-backed entry — stream from disk
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
    }

    yield tarPaddingBytes(entrySize);
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
  const {
    assistant,
    origin,
    compatibility,
    exportOptions,
    secretsRedacted,
    checkpoint,
    workspaceDir,
    credentials,
  } = options;

  // Flush WAL to the main database file before reading
  if (checkpoint) {
    checkpoint();
  }

  const allFileMetadata: FileMetadata[] = [];
  const symlinkEntries: SymlinkMetadata[] = [];

  // Walk the entire workspace directory, including binary files
  if (
    workspaceDir &&
    existsSync(workspaceDir) &&
    lstatSync(workspaceDir).isDirectory()
  ) {
    const {
      files: walkedFiles,
      symlinks: walkedSymlinks,
      droppedSymlinks,
    } = walkDirectoryForMetadata(workspaceDir, "workspace", {
      includeBinary: true,
      skipDirs: ["embedding-models", "data/qdrant", "signals", "deprecated"],
    });
    allFileMetadata.push(...walkedFiles);
    symlinkEntries.push(...walkedSymlinks);
    if (droppedSymlinks.length > 0) {
      getLogger("vbundle-builder").warn(
        { count: droppedSymlinks.length, paths: droppedSymlinks },
        `Dropped ${droppedSymlinks.length} symlinks pointing outside workspace or into skipped directories`,
      );
    }
  }

  // Sanitize workspace/config.json: read from disk, sanitize, and replace the
  // disk-backed metadata entry with an in-memory entry so the streaming tar
  // writes sanitized content instead of the raw file.
  const configMetadataIdx = allFileMetadata.findIndex(
    (f) => f.archivePath === "workspace/config.json",
  );

  const sanitizedConfigEntries: InMemoryEntry[] = [];
  if (configMetadataIdx !== -1) {
    const configMeta = allFileMetadata[configMetadataIdx];
    const rawConfigData = readFileSync(configMeta.diskPath, "utf8");
    const sanitized = sanitizeConfigForTransfer(rawConfigData);
    const sanitizedData = new TextEncoder().encode(sanitized);

    // Remove the disk-backed entry and replace with an in-memory entry
    allFileMetadata.splice(configMetadataIdx, 1);
    sanitizedConfigEntries.push({
      archivePath: "workspace/config.json",
      data: sanitizedData,
      size: sanitizedData.length,
    });
  }

  // Build in-memory entries for credentials (not disk-backed)
  const inMemoryEntries: InMemoryEntry[] = [];
  if (credentials?.length) {
    for (const { account, value } of credentials) {
      const data = new TextEncoder().encode(value);
      inMemoryEntries.push({
        archivePath: `credentials/${account}`,
        data,
        size: data.length,
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
      size_bytes: file.size,
    });
  }

  // Add in-memory entries (sanitized config, credentials) to the manifest
  for (const entry of [...sanitizedConfigEntries, ...inMemoryEntries]) {
    const sha256 = sha256Hex(entry.data);
    fileEntries.push({
      path: entry.archivePath,
      sha256,
      size_bytes: entry.size,
    });
  }

  // Add symlink entries to the manifest. The sha256 is computed over the
  // link target string (UTF-8 encoded) so the streaming validator can
  // verify the manifest declared the same target the tar header carries.
  // size_bytes is always 0 for symlink entries.
  for (const entry of symlinkEntries) {
    fileEntries.push({
      path: entry.archivePath,
      sha256: sha256Hex(entry.linkTarget),
      size_bytes: 0,
      link_target: entry.linkTarget,
    });
  }

  const { manifest, manifestData } = buildManifestObject({
    contents: fileEntries,
    assistant,
    origin,
    compatibility,
    exportOptions,
    secretsRedacted,
    now: new Date(),
  });

  // ------------------------------------------------------------------
  // Pass 2: Stream tar through gzip into a temp file
  // ------------------------------------------------------------------

  const tempPath = join(tmpdir(), `vbundle-export-${randomUUID()}.tmp`);

  const allEntries: TarStreamEntry[] = [
    ...allFileMetadata,
    ...sanitizedConfigEntries,
    ...inMemoryEntries,
    ...symlinkEntries,
  ];
  const tarGenerator = generateTarStream(manifestData, allEntries);
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
