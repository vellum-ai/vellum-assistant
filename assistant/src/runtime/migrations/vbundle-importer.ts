/**
 * Commits a validated .vbundle archive to disk.
 *
 * Given a .vbundle archive, this module:
 * 1. Validates the bundle (decompresses and parses once — reuses the entries
 *    from validation to avoid a second decompression pass)
 * 2. Backs up existing files before overwriting
 * 3. Writes bundle files to their target disk locations
 * 4. Verifies written files match expected checksums (post-write integrity)
 * 5. Returns a detailed import report
 *
 * Backup files are stored alongside the originals with a timestamped suffix.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { PathResolver } from "./vbundle-import-analyzer.js";
import type { ManifestType, VBundleTarEntry } from "./vbundle-validator.js";
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
  /** Raw .vbundle archive bytes — used only when pre-validated data is not provided. */
  archiveData: Uint8Array;
  /** Resolves archive paths to disk paths */
  pathResolver: PathResolver;
  /** Pre-validated manifest from a prior validateVBundle call. When provided
   *  with `preValidatedEntries`, skips internal re-validation to avoid
   *  holding two copies of decompressed data in memory. */
  preValidatedManifest?: ManifestType;
  /** Pre-parsed tar entries from a prior validateVBundle call. */
  preValidatedEntries?: Map<string, VBundleTarEntry>;
}

/**
 * Validate, extract, and write a .vbundle archive to disk.
 *
 * This is a destructive operation — files on disk will be overwritten.
 * Existing files are backed up before being replaced. The bundle is
 * re-validated before any state mutation to prevent writing corrupt data.
 */
export function commitImport(options: ImportCommitOptions): ImportCommitResult {
  const {
    archiveData,
    pathResolver,
    preValidatedManifest,
    preValidatedEntries,
  } = options;

  let manifest: ManifestType;
  let entryMap: Map<string, VBundleTarEntry>;

  if (preValidatedManifest && preValidatedEntries) {
    // Caller already validated and decompressed — reuse directly
    manifest = preValidatedManifest;
    entryMap = preValidatedEntries;
  } else {
    // Validate the bundle (validation before mutation).
    // validateVBundle decompresses and parses the tar, returning the entries
    // alongside the validation result so we avoid a second decompression.
    const validation = validateVBundle(archiveData);
    if (!validation.is_valid || !validation.manifest || !validation.entries) {
      return {
        ok: false,
        reason: "validation_failed",
        errors: validation.errors,
      };
    }

    manifest = validation.manifest;
    entryMap = validation.entries;
  }

  // Step 1b: Back up and clear directories that will be fully restored from
  // the bundle. We rename (not delete) to preserve a recoverable backup in
  // case a later write fails — this prevents irrecoverable data loss.
  for (const prefix of ["skills/", "hooks/"] as const) {
    const hasEntries = manifest.files.some((f) => f.path.startsWith(prefix));
    if (!hasEntries) continue;

    const dirRoot = pathResolver.resolveRoot?.(prefix);
    if (!dirRoot || !existsSync(dirRoot)) continue;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${dirRoot}.pre-import-backup-${timestamp}`;
    try {
      renameSync(dirRoot, backupPath);
    } catch (err) {
      const label = prefix.slice(0, -1); // "skills" or "hooks"
      return {
        ok: false,
        reason: "write_failed",
        message: `Failed to backup ${label} directory "${dirRoot}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  // Step 1d: Clear stale prompt files if the bundle contains prompts entries.
  // Only the known prompt filenames are accepted, so delete each one that
  // currently exists to avoid stale prompts surviving a restore.
  const hasPromptsEntries = manifest.files.some((f) =>
    f.path.startsWith("prompts/"),
  );
  if (hasPromptsEntries) {
    const PROMPT_FILENAMES = [
      "IDENTITY.md",
      "SOUL.md",
      "USER.md",
      "UPDATES.md",
    ];
    for (const filename of PROMPT_FILENAMES) {
      const diskPath = pathResolver.resolve(`prompts/${filename}`);
      if (diskPath && existsSync(diskPath)) {
        try {
          unlinkSync(diskPath);
        } catch {
          // Non-fatal — the file will be overwritten or left as-is
        }
      }
    }
  }

  // Step 2: Write files to disk with backups
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
          message: `Failed to create backup of "${diskPath}": ${
            err instanceof Error ? err.message : String(err)
          }`,
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
          message: `Failed to create directory "${parentDir}": ${
            err instanceof Error ? err.message : String(err)
          }`,
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
        message: `Failed to write "${diskPath}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        partial_report: buildPartialReport(
          importedFiles,
          manifest,
          warnings,
          backupsCreated,
        ),
      };
    }

    // Step 3: Post-write integrity check — verify the written file
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
