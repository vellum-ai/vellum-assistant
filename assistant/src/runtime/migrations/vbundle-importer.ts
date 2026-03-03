/**
 * Commits a validated .vbundle archive to disk.
 *
 * Given a valid .vbundle archive (already validated), this module:
 * 1. Re-validates the bundle for safety (validation before mutation)
 * 2. Extracts files from the archive
 * 3. Backs up existing files before overwriting
 * 4. Writes bundle files to their target disk locations
 * 5. Verifies written files match expected checksums (post-write integrity)
 * 6. Returns a detailed import report
 *
 * Backup files are stored alongside the originals with a timestamped suffix.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";

import type { PathResolver } from "./vbundle-import-analyzer.js";
import type { ManifestType } from "./vbundle-validator.js";
import { validateVBundle } from "./vbundle-validator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ImportFileAction = "created" | "overwritten" | "skipped";

export interface ImportedFileReport {
  /** Archive path (e.g. "data/db/assistant.db") */
  path: string;
  /** Disk path the file was written to */
  disk_path: string;
  /** What happened to this file */
  action: ImportFileAction;
  /** Size of the written file in bytes */
  size: number;
  /** SHA-256 of the written file */
  sha256: string;
  /** Path to the backup file, if one was created */
  backup_path: string | null;
}

export interface ImportCommitReport {
  /** Whether the import succeeded */
  success: boolean;
  /** Summary of what was imported */
  summary: {
    total_files: number;
    files_created: number;
    files_overwritten: number;
    files_skipped: number;
    backups_created: number;
  };
  /** Per-file import details */
  files: ImportedFileReport[];
  /** The manifest from the imported bundle */
  manifest: ManifestType;
  /** Any integrity warnings (non-fatal) */
  warnings: string[];
}

export type ImportCommitResult =
  | { ok: true; report: ImportCommitReport }
  | {
      ok: false;
      reason: "validation_failed";
      errors: Array<{ code: string; message: string; path?: string }>;
    }
  | { ok: false; reason: "extraction_failed"; message: string }
  | {
      ok: false;
      reason: "write_failed";
      message: string;
      partial_report?: ImportCommitReport;
    };

// ---------------------------------------------------------------------------
// Tar parsing (duplicated from validator — the validator's parser is private)
// ---------------------------------------------------------------------------

interface TarEntry {
  name: string;
  data: Uint8Array;
  size: number;
}

function parseTar(buffer: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  const BLOCK_SIZE = 512;
  let longName: string | null = null;

  while (offset + BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE);

    if (header.every((b) => b === 0)) {
      break;
    }

    let name: string;
    if (longName) {
      name = longName;
      longName = null;
    } else {
      const rawName = decodeNullTerminated(header, 0, 100);
      const prefix = decodeNullTerminated(header, 345, 155);
      name = prefix ? `${prefix}/${rawName}` : rawName;
    }

    const typeFlag = String.fromCharCode(header[156]);

    const sizeStr = decodeNullTerminated(header, 124, 12);
    const size = parseInt(sizeStr, 8) || 0;

    const dataBlocks = Math.ceil(size / BLOCK_SIZE);
    const dataStart = offset + BLOCK_SIZE;
    const data = buffer.subarray(dataStart, dataStart + size);

    if (typeFlag === "L") {
      longName = new TextDecoder().decode(data).replace(/\0+$/, "");
      offset = dataStart + dataBlocks * BLOCK_SIZE;
      continue;
    }

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
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Backup helper
// ---------------------------------------------------------------------------

function generateBackupPath(diskPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${diskPath}.backup-${timestamp}`;
}

// ---------------------------------------------------------------------------
// Core importer
// ---------------------------------------------------------------------------

export interface ImportCommitOptions {
  /** Raw .vbundle archive bytes */
  archiveData: Uint8Array;
  /** Resolves archive paths to disk paths */
  pathResolver: PathResolver;
}

/**
 * Validate, extract, and write a .vbundle archive to disk.
 *
 * This is a destructive operation — files on disk will be overwritten.
 * Existing files are backed up before being replaced. The bundle is
 * re-validated before any state mutation to prevent writing corrupt data.
 */
export function commitImport(options: ImportCommitOptions): ImportCommitResult {
  const { archiveData, pathResolver } = options;

  // Step 1: Validate the bundle (validation before mutation)
  const validation = validateVBundle(archiveData);
  if (!validation.is_valid || !validation.manifest) {
    return {
      ok: false,
      reason: "validation_failed",
      errors: validation.errors,
    };
  }

  const manifest = validation.manifest;

  // Step 2: Extract tar entries
  let tarData: Uint8Array;
  try {
    tarData = gunzipSync(archiveData);
  } catch (err) {
    return {
      ok: false,
      reason: "extraction_failed",
      message: `Failed to decompress archive: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let entries: TarEntry[];
  try {
    entries = parseTar(tarData);
  } catch (err) {
    return {
      ok: false,
      reason: "extraction_failed",
      message: `Failed to parse tar archive: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const entryMap = new Map<string, TarEntry>();
  for (const entry of entries) {
    entryMap.set(entry.name, entry);
  }

  // Step 3: Write files to disk with backups
  const importedFiles: ImportedFileReport[] = [];
  const warnings: string[] = [];
  let backupsCreated = 0;

  for (const fileEntry of manifest.files) {
    const diskPath = pathResolver.resolve(fileEntry.path);

    if (!diskPath) {
      // Unknown archive path — skip it
      importedFiles.push({
        path: fileEntry.path,
        disk_path: "",
        action: "skipped",
        size: fileEntry.size,
        sha256: fileEntry.sha256,
        backup_path: null,
      });
      warnings.push(
        `Skipped "${fileEntry.path}": no known disk target for this archive path`,
      );
      continue;
    }

    const archiveEntry = entryMap.get(fileEntry.path);
    if (!archiveEntry) {
      // File declared in manifest but not found in archive — should not
      // happen after validation, but guard against it
      importedFiles.push({
        path: fileEntry.path,
        disk_path: diskPath,
        action: "skipped",
        size: fileEntry.size,
        sha256: fileEntry.sha256,
        backup_path: null,
      });
      warnings.push(
        `Skipped "${fileEntry.path}": declared in manifest but not found in archive`,
      );
      continue;
    }

    // Determine action and create backup if needed
    let backupPath: string | null = null;
    let action: ImportFileAction;

    if (existsSync(diskPath)) {
      // Back up existing file before overwriting
      backupPath = generateBackupPath(diskPath);
      try {
        copyFileSync(diskPath, backupPath);
        backupsCreated++;
      } catch (err) {
        return {
          ok: false,
          reason: "write_failed",
          message: `Failed to create backup of "${diskPath}": ${err instanceof Error ? err.message : String(err)}`,
          partial_report: buildPartialReport(
            importedFiles,
            manifest,
            warnings,
            backupsCreated,
          ),
        };
      }
      action = "overwritten";
    } else {
      action = "created";
    }

    // Ensure parent directory exists
    const parentDir = dirname(diskPath);
    if (!existsSync(parentDir)) {
      try {
        mkdirSync(parentDir, { recursive: true });
      } catch (err) {
        return {
          ok: false,
          reason: "write_failed",
          message: `Failed to create directory "${parentDir}": ${err instanceof Error ? err.message : String(err)}`,
          partial_report: buildPartialReport(
            importedFiles,
            manifest,
            warnings,
            backupsCreated,
          ),
        };
      }
    }

    // Write the file
    try {
      writeFileSync(diskPath, archiveEntry.data);
    } catch (err) {
      return {
        ok: false,
        reason: "write_failed",
        message: `Failed to write "${diskPath}": ${err instanceof Error ? err.message : String(err)}`,
        partial_report: buildPartialReport(
          importedFiles,
          manifest,
          warnings,
          backupsCreated,
        ),
      };
    }

    // Step 4: Post-write integrity check — verify the written file
    try {
      const writtenData = new Uint8Array(readFileSync(diskPath));
      const writtenSha256 = sha256Hex(writtenData);

      if (writtenSha256 !== fileEntry.sha256) {
        warnings.push(
          `Post-write integrity warning for "${fileEntry.path}": ` +
            `expected SHA-256 ${fileEntry.sha256}, got ${writtenSha256}`,
        );
      }
    } catch {
      warnings.push(
        `Could not verify post-write integrity for "${fileEntry.path}"`,
      );
    }

    importedFiles.push({
      path: fileEntry.path,
      disk_path: diskPath,
      action,
      size: archiveEntry.size,
      sha256: fileEntry.sha256,
      backup_path: backupPath,
    });
  }

  // Build final report
  const report: ImportCommitReport = {
    success: true,
    summary: {
      total_files: importedFiles.length,
      files_created: importedFiles.filter((f) => f.action === "created").length,
      files_overwritten: importedFiles.filter((f) => f.action === "overwritten")
        .length,
      files_skipped: importedFiles.filter((f) => f.action === "skipped").length,
      backups_created: backupsCreated,
    },
    files: importedFiles,
    manifest,
    warnings,
  };

  return { ok: true, report };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPartialReport(
  files: ImportedFileReport[],
  manifest: ManifestType,
  warnings: string[],
  backupsCreated: number,
): ImportCommitReport {
  return {
    success: false,
    summary: {
      total_files: files.length,
      files_created: files.filter((f) => f.action === "created").length,
      files_overwritten: files.filter((f) => f.action === "overwritten").length,
      files_skipped: files.filter((f) => f.action === "skipped").length,
      backups_created: backupsCreated,
    },
    files,
    manifest,
    warnings,
  };
}
