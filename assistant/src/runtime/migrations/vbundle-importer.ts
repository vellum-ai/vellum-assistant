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
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

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
  /**
   * Absolute path to the workspace directory. When set and the bundle
   * contains workspace/ entries, the workspace is cleared (except
   * skip dirs) before writing to ensure an exact-match restore.
   */
  workspaceDir?: string;
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
    workspaceDir,
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

  // Directories to preserve when clearing the workspace.
  const WORKSPACE_SKIP_DIRS = new Set(["embedding-models", "deprecated"]);
  // data/qdrant and data/db are nested — we skip them inside "data/"
  const DATA_SKIP_DIRS = new Set(["qdrant", "db"]);

  // Step 1b: Clear the workspace directory before restore if the bundle
  // contains new-format workspace/ entries. This ensures an exact-match
  // restore with no stale files left behind. Skips embedding-models/,
  // data/qdrant/ (large, regenerable), and data/db/ (critical — prevents
  // data loss if the import fails partway or the archive omits the DB).
  //
  // Only new-format bundles (workspace/ prefix) trigger clearing. Old-format
  // bundles (skills/, hooks/, data/db/*, config/*) wrote specific files
  // without clearing — preserving that behavior avoids wiping workspace
  // data when importing legacy bundles.
  //
  // Gate on resolution: at least one workspace/ entry must resolve to a
  // valid disk path. This prevents path-traversal entries (e.g.
  // "workspace/../../etc/passwd") from triggering a workspace purge while
  // resolving to nothing.
  const hasWorkspaceEntries = manifest.files.some(
    (f) => f.path.startsWith("workspace/") && !!pathResolver.resolve(f.path),
  );

  if (hasWorkspaceEntries && workspaceDir && existsSync(workspaceDir)) {
    try {
      // Clear workspace contents selectively, preserving skip dirs
      const topEntries = readdirSync(workspaceDir, { withFileTypes: true });
      for (const entry of topEntries) {
        if (WORKSPACE_SKIP_DIRS.has(entry.name)) continue;

        const entryPath = join(workspaceDir, entry.name);
        if (entry.name === "data" && entry.isDirectory()) {
          // Inside data/, preserve qdrant/ (large, regenerable) and db/
          // (critical user data) but clear everything else
          const dataEntries = readdirSync(entryPath, { withFileTypes: true });
          for (const dataEntry of dataEntries) {
            if (DATA_SKIP_DIRS.has(dataEntry.name)) continue;
            rmSync(join(entryPath, dataEntry.name), {
              recursive: true,
              force: true,
            });
          }
        } else {
          rmSync(entryPath, { recursive: true, force: true });
        }
      }
    } catch (err) {
      return {
        ok: false,
        reason: "write_failed",
        message: `Failed to clear workspace directory "${workspaceDir}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
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
// Credential extraction
// ---------------------------------------------------------------------------

/**
 * Extract credential entries from a validated vbundle tar entries map.
 *
 * Credentials are stored under the `credentials/` prefix in the archive,
 * where the remainder of the path is the account name and the entry data
 * is the credential value.
 */
export function extractCredentialsFromBundle(
  entries: Map<string, VBundleTarEntry>,
): Array<{ account: string; value: string }> {
  const credentials: Array<{ account: string; value: string }> = [];
  for (const [path, entry] of entries) {
    if (path.startsWith("credentials/")) {
      const account = path.slice("credentials/".length);
      if (account) {
        const value = new TextDecoder().decode(entry.data);
        credentials.push({ account, value });
      }
    }
  }
  return credentials;
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
