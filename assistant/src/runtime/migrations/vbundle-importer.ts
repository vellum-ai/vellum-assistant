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
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { sanitizeConfigForTransfer } from "../../config/sanitize-for-transfer.js";
import { isGuardianPersonaCustomized } from "../../prompts/persona-resolver.js";
import { getLogger } from "../../util/logger.js";
import { APP_VERSION } from "../../version.js";
import type { PathResolver } from "./vbundle-import-analyzer.js";
import type { RuntimeCompatibility } from "./vbundle-import-policy.js";
import * as policy from "./vbundle-import-policy.js";
import { mergeMetadataPreservingVellum } from "./vbundle-metadata-merge.js";
import type { ManifestType, VBundleTarEntry } from "./vbundle-validator.js";
import { validateVBundle } from "./vbundle-validator.js";

const log = getLogger("vbundle-importer");

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
      reason: "version_incompatible";
      bundle_compat: RuntimeCompatibility;
      runtime_version: string;
    }
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

/**
 * Defense-in-depth: returns true if `linkTarget`, when resolved relative to
 * the symlink's own directory (`dirname(diskPath)`), lands outside the
 * supplied `workspaceDir`. The validator (`validateVBundle`) already enforces
 * archive-relative containment, but we re-check here so the buffer importer
 * is safe even if a caller passes a hand-built `preValidatedManifest`.
 *
 * Returns false when `workspaceDir` is undefined — the importer is permitted
 * to write outside any workspace in that mode (e.g. legacy hooks-only
 * imports).
 */
function isOutsideWorkspace(
  diskPath: string,
  linkTarget: string,
  workspaceDir: string | undefined,
): boolean {
  if (!workspaceDir) return false;
  const resolved = resolve(dirname(diskPath), linkTarget);
  const ws = resolve(workspaceDir);
  return resolved !== ws && !resolved.startsWith(ws + sep);
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

  // Defense-in-depth: refuse to import a bundle whose declared compat range
  // excludes this runtime BEFORE any state mutation. The platform-side gate
  // is the primary check; this catches legacy bundles whose ExportJob row
  // predates PR #5470 (compat columns NULL → platform gate skipped) and
  // any caller that bypasses the platform-issued signed URL flow.
  const compatResult = policy.evaluateRuntimeCompatibility(
    manifest.compatibility,
    APP_VERSION,
  );
  if (!compatResult.ok) {
    return {
      ok: false,
      reason: "version_incompatible",
      bundle_compat: compatResult.bundle_compat,
      runtime_version: compatResult.runtime_version,
    };
  }

  // Directories to preserve when clearing the workspace. Derived from the
  // shared WORKSPACE_PRESERVE_PATHS list so the streaming importer's
  // carry-over logic and this in-place clear stay in sync.
  const { topLevelSkipDirs, dataSubdirSkipDirs } =
    policy.partitionWorkspacePreserveSkipDirs();

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
  const hasWorkspaceEntries = manifest.contents.some(
    (f) =>
      policy.isWorkspaceNamespacedArchivePath(f.path) &&
      !!pathResolver.resolve(f.path),
  );

  // Capture the target's credential metadata BEFORE the workspace clear
  // runs. Step 1b wipes `data/credentials/`, so reading live metadata
  // later (during the per-file write loop) would always miss. The merge
  // helper needs this content to preserve the target's platform-identity
  // (`vellum:*`) entries across the overwrite.
  let liveCredentialMetadataJson: string | null = null;
  const credentialMetadataDiskPath = pathResolver.resolve(
    policy.CREDENTIAL_METADATA_ARCHIVE_PATH,
  );
  if (credentialMetadataDiskPath && existsSync(credentialMetadataDiskPath)) {
    try {
      liveCredentialMetadataJson = readFileSync(
        credentialMetadataDiskPath,
        "utf-8",
      );
    } catch (err) {
      log.warn(
        { err, path: credentialMetadataDiskPath },
        "Failed to read live credential metadata before import; vellum:* entries may not be preserved",
      );
    }
  }

  let workspaceWasCleared = false;
  if (hasWorkspaceEntries && workspaceDir && existsSync(workspaceDir)) {
    try {
      // Clear workspace contents selectively, preserving skip dirs
      const topEntries = readdirSync(workspaceDir, { withFileTypes: true });
      for (const entry of topEntries) {
        if (topLevelSkipDirs.has(entry.name)) continue;

        const entryPath = join(workspaceDir, entry.name);
        if (entry.name === "data" && entry.isDirectory()) {
          // Inside data/, preserve qdrant/ (large, regenerable) and db/
          // (critical user data) but clear everything else
          const dataEntries = readdirSync(entryPath, { withFileTypes: true });
          for (const dataEntry of dataEntries) {
            if (dataSubdirSkipDirs.has(dataEntry.name)) continue;
            rmSync(join(entryPath, dataEntry.name), {
              recursive: true,
              force: true,
            });
          }
        } else {
          rmSync(entryPath, { recursive: true, force: true });
        }
      }
      workspaceWasCleared = true;
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

  for (const fileEntry of manifest.contents) {
    // Credential entries are handled separately by extractCredentialsFromBundle()
    // in migration-routes.ts — skip them silently without warnings or skip counts.
    if (fileEntry.path.startsWith("credentials/")) {
      continue;
    }

    const diskPath = pathResolver.resolve(fileEntry.path);

    if (!diskPath) {
      // Unknown archive path — skip it
      importedFiles.push({
        path: fileEntry.path,
        disk_path: "",
        action: "skipped",
        size: fileEntry.size_bytes,
        sha256: fileEntry.sha256,
        backup_path: null,
      });
      warnings.push(
        `Skipped "${fileEntry.path}": no known disk target for this archive path`,
      );
      continue;
    }

    // Symlink branch: recreate the entry on disk as a real symlink so the
    // post-import workspace mirrors the source's link topology rather than
    // duplicating bytes. The validator already enforces archive-relative
    // containment, sha256-over-target, and size==0 — we still reapply
    // absolute-target and workspace-escape gates here so a hand-built
    // `preValidatedManifest` cannot bypass them.
    if (fileEntry.link_target !== undefined) {
      const archiveEntry = entryMap.get(fileEntry.path);
      if (!archiveEntry) {
        importedFiles.push({
          path: fileEntry.path,
          disk_path: diskPath,
          action: "skipped",
          size: 0,
          sha256: fileEntry.sha256,
          backup_path: null,
        });
        warnings.push(
          `Skipped "${fileEntry.path}": declared in manifest but not found in archive`,
        );
        continue;
      }

      // Legacy guardian persona (prompts/USER.md) is translated to the
      // current guardian's users/<slug>.md by DefaultPathResolver. If the
      // bundle ships USER.md as a symlink and the target already holds
      // user-authored content, skip rather than clobber — mirrors the
      // protection in the regular-file branch below.
      if (
        policy.isLegacyPersonaArchivePath(fileEntry.path) &&
        isGuardianPersonaCustomized(diskPath)
      ) {
        log.warn(
          { archivePath: fileEntry.path, diskPath },
          "Skipping legacy prompts/USER.md symlink import: guardian persona is already customized",
        );
        warnings.push(
          `Skipped "${fileEntry.path}": guardian persona at "${diskPath}" is already customized`,
        );
        importedFiles.push({
          path: fileEntry.path,
          disk_path: diskPath,
          action: "skipped",
          size: 0,
          sha256: fileEntry.sha256,
          backup_path: null,
        });
        continue;
      }

      // Defense-in-depth path-traversal gate.
      if (
        fileEntry.link_target.startsWith("/") ||
        isOutsideWorkspace(diskPath, fileEntry.link_target, workspaceDir)
      ) {
        importedFiles.push({
          path: fileEntry.path,
          disk_path: diskPath,
          action: "skipped",
          size: 0,
          sha256: fileEntry.sha256,
          backup_path: null,
        });
        warnings.push(
          `Skipped "${fileEntry.path}": symlink target "${fileEntry.link_target}" escapes workspace`,
        );
        continue;
      }

      // Back up an existing entry at diskPath, if any. Use `lstatSync` so we
      // detect a pre-existing dangling symlink (which `existsSync` reports
      // as missing) — `symlinkSync` would otherwise fail with EEXIST. For
      // regular files and resolvable symlinks we copy the file contents into
      // the backup, matching the existing contract; for dangling symlinks
      // we preserve the linkname via `readlinkSync`+`symlinkSync` so the
      // original entry can be inspected after the import. The pre-existing
      // entry is removed before `symlinkSync` so the new symlink can land.
      let backupPath: string | null = null;
      let action: ImportFileAction;
      let preExistingEntry = false;
      let preExistingIsSymlink = false;
      try {
        const stats = lstatSync(diskPath);
        preExistingEntry = true;
        preExistingIsSymlink = stats.isSymbolicLink();
      } catch {
        // ENOENT — no pre-existing entry at this path.
      }
      if (preExistingEntry) {
        backupPath = generateBackupPath(diskPath);
        try {
          if (preExistingIsSymlink) {
            const oldTarget = readlinkSync(diskPath);
            symlinkSync(oldTarget, backupPath);
          } else {
            copyFileSync(diskPath, backupPath);
          }
          backupsCreated++;
        } catch (err) {
          return {
            ok: false,
            reason: "write_failed",
            message: `Failed to back up "${diskPath}": ${
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
        try {
          rmSync(diskPath, { force: true });
        } catch {
          /* best effort — symlinkSync below will surface the real error */
        }
      } else {
        action = "created";
      }

      // Ensure parent directory exists.
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

      // Create the symlink. The target is stored verbatim — OS symlink
      // semantics resolve it relative to the symlink's own directory at
      // use time.
      try {
        symlinkSync(fileEntry.link_target, diskPath);
      } catch (err) {
        return {
          ok: false,
          reason: "write_failed",
          message: `Failed to create symlink "${diskPath}" -> "${fileEntry.link_target}": ${
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

      importedFiles.push({
        path: fileEntry.path,
        disk_path: diskPath,
        action,
        size: 0,
        sha256: fileEntry.sha256,
        backup_path: backupPath,
      });
      // Skip the regular-file branches (and the post-write integrity check,
      // which would dereference the symlink and read the target's bytes).
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
        size: fileEntry.size_bytes,
        sha256: fileEntry.sha256,
        backup_path: null,
      });
      warnings.push(
        `Skipped "${fileEntry.path}": declared in manifest but not found in archive`,
      );
      continue;
    }

    // Legacy guardian persona (prompts/USER.md) is translated to the
    // current guardian's users/<slug>.md by DefaultPathResolver. If
    // that target already holds user-authored content, skip rather
    // than clobber — the user has curated their persona since the
    // bundle was exported.
    if (
      policy.isLegacyPersonaArchivePath(fileEntry.path) &&
      isGuardianPersonaCustomized(diskPath)
    ) {
      log.warn(
        { archivePath: fileEntry.path, diskPath },
        "Skipping legacy prompts/USER.md import: guardian persona is already customized",
      );
      warnings.push(
        `Skipped "${fileEntry.path}": guardian persona at "${diskPath}" is already customized`,
      );
      importedFiles.push({
        path: fileEntry.path,
        disk_path: diskPath,
        action: "skipped",
        size: fileEntry.size_bytes,
        sha256: fileEntry.sha256,
        backup_path: null,
      });
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

    // Sanitize config files to strip environment-specific fields (defense-in-depth)
    let dataToWrite: Uint8Array = archiveEntry.data;
    if (policy.isConfigArchivePath(fileEntry.path)) {
      const configJson = new TextDecoder().decode(archiveEntry.data);
      const sanitized = sanitizeConfigForTransfer(configJson);
      dataToWrite = new TextEncoder().encode(sanitized);
    }

    // Preserve target's `vellum:*` metadata entries across the overwrite.
    // Django's post-hatch provisioning writes these on the target via
    // POST /v1/secrets; a naive overwrite of the bundle's metadata.json
    // would wipe them and break the gateway's vellum credential read.
    // We use the snapshot captured BEFORE the workspace clear because
    // Step 1b may have already removed the live file.
    if (policy.isCredentialMetadataArchivePath(fileEntry.path)) {
      const bundleJson = new TextDecoder().decode(archiveEntry.data);
      const merged = mergeMetadataPreservingVellum(
        bundleJson,
        liveCredentialMetadataJson,
      );
      dataToWrite = new TextEncoder().encode(merged);
    }

    // If we're about to replace a SQLite main database file, remove any
    // pre-existing `.db-wal`/`.db-shm`/`.db-journal` siblings at the
    // target. Those auxiliary files are only valid as a pair with the
    // exact `.db` that wrote them; leaving them alongside a replacement
    // DB causes SQLite to replay incompatible WAL frames on the first
    // open and report "database disk image is malformed". The exporter
    // already checkpointed the source WAL into the main DB before the
    // bundle was built, so dropping the sibling aux files doesn't lose
    // data from the source workspace.
    if (diskPath.endsWith(".db")) {
      for (const suffix of [".db-wal", ".db-shm", ".db-journal"]) {
        const auxPath = `${diskPath.slice(0, -".db".length)}${suffix}`;
        try {
          rmSync(auxPath, { force: true });
        } catch {
          /* best effort — if the aux file doesn't exist we're fine */
        }
      }
    }

    // Write the file
    try {
      writeFileSync(diskPath, dataToWrite);
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
    // Use the SHA of the data we actually wrote (which may differ from the
    // manifest SHA if the config was sanitized during import).
    const expectedSha256 = sha256Hex(dataToWrite);
    try {
      const writtenData = new Uint8Array(readFileSync(diskPath));
      const writtenSha256 = sha256Hex(writtenData);

      if (writtenSha256 !== expectedSha256) {
        warnings.push(
          `Post-write integrity warning for "${fileEntry.path}": ` +
            `expected SHA-256 ${expectedSha256}, got ${writtenSha256}`,
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
      size: dataToWrite.length,
      sha256: expectedSha256,
      backup_path: backupPath,
    });
  }

  // If Step 1b actually cleared the workspace AND the bundle did not
  // carry a metadata.json entry, the target's vellum:* entries were
  // wiped along with the `data/credentials/` directory. Restore them by
  // writing a minimal file containing just the preserved entries so the
  // gateway can still locate the platform API key. When Step 1b did NOT
  // run (e.g. workspaceDir unset) the live metadata.json is still on
  // disk untouched — we must not rewrite it here or we would drop the
  // non-vellum entries the caller chose to keep.
  const bundleHadMetadata = manifest.contents.some((f) =>
    policy.isCredentialMetadataArchivePath(f.path),
  );
  if (
    workspaceWasCleared &&
    !bundleHadMetadata &&
    liveCredentialMetadataJson &&
    credentialMetadataDiskPath
  ) {
    const merged = mergeMetadataPreservingVellum(
      JSON.stringify({ version: 5, credentials: [] }),
      liveCredentialMetadataJson,
    );
    try {
      mkdirSync(dirname(credentialMetadataDiskPath), { recursive: true });
      writeFileSync(credentialMetadataDiskPath, merged);
    } catch (err) {
      warnings.push(
        `Failed to restore preserved vellum:* credential metadata: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
  manifest: ManifestType,
): Array<{ account: string; value: string }> {
  const manifestPaths = new Set(manifest.contents.map((f) => f.path));
  const credentials: Array<{ account: string; value: string }> = [];
  for (const [path, entry] of entries) {
    if (path.startsWith("credentials/") && manifestPaths.has(path)) {
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
