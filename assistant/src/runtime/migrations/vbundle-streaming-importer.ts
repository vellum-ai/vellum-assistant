/**
 * Streaming `.vbundle` importer.
 *
 * Buffer-based `commitImport` decompresses the whole archive into RAM and
 * re-walks the tar to write each file — fine for small bundles, OOMs on an
 * 8 GB bundle running on a 3 GB pod. This module orchestrates the streaming
 * primitives from PR 2 (`parseVBundleStream`) and PR 3
 * (`readAndValidateManifest`, `createHashVerifier`) to import a bundle with
 * peak memory bounded by "one tar entry size", not bundle size.
 *
 * Atomicity is provided by a temp-dir + double-rename pattern:
 *
 *   1. Entries land in `${workspaceDir}.import-<uuid>/` as they arrive, each
 *      byte verified against the manifest's declared sha256/size before it
 *      reaches disk.
 *   2. After every declared entry is accounted for, the live DB connection
 *      is closed (`resetDb`) and the real workspace is swapped:
 *        `rename(workspaceDir, backupDir)`
 *        `rename(tempWorkspaceDir, workspaceDir)`
 *      — atomic on POSIX. If the second rename fails we restore the backup.
 *   3. Post-commit side effects (credential import into CES, config/trust
 *      cache invalidation) run after the swap. Failures here are non-fatal
 *      — the workspace is already consistent.
 *
 * On any error before the rename pair, the temp workspace is removed and the
 * real workspace is left untouched.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { invalidateConfigCache } from "../../config/loader.js";
import { sanitizeConfigForTransfer } from "../../config/sanitize-for-transfer.js";
import { resetDb } from "../../memory/db-connection.js";
import { clearCache as clearTrustCache } from "../../permissions/trust-store.js";
import { isGuardianPersonaCustomized } from "../../prompts/persona-resolver.js";
import { getLogger } from "../../util/logger.js";
import type { PathResolver } from "./vbundle-import-analyzer.js";
import {
  CONFIG_ARCHIVE_PATHS,
  type ImportCommitReport,
  type ImportCommitResult,
  type ImportedFileReport,
  type ImportFileAction,
  LEGACY_USER_MD_ARCHIVE_PATH,
} from "./vbundle-importer.js";
import {
  createHashVerifier,
  readAndValidateManifest,
  StreamingValidationError,
} from "./vbundle-streaming-validator.js";
import { parseVBundleStream } from "./vbundle-tar-stream.js";
import type { ManifestType } from "./vbundle-validator.js";

const log = getLogger("vbundle-streaming-importer");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StreamProgressEvent {
  /** Archive path of the entry that just finished streaming. */
  archivePath: string;
  /** Total bytes written for that entry (equals manifest-declared size on success). */
  bytesWritten: number;
  /**
   * Zero-based index of the entry in the order it arrived in the tar. The
   * manifest itself is index 0; the first file entry is index 1.
   */
  entryIndex: number;
}

export interface StreamCommitArgs {
  /** Byte source for the `.vbundle`. Typically an HTTP response body. */
  source: Readable;
  /** Maps archive paths to their canonical disk locations. */
  pathResolver: PathResolver;
  /** Absolute path to the real workspace directory. */
  workspaceDir: string;
  /** Optional progress callback invoked after each file entry finishes. */
  onProgress?: (evt: StreamProgressEvent) => void;
  /**
   * Optional callback for importing credentials into CES after the atomic
   * swap succeeds. Failures are treated as non-fatal warnings. When omitted,
   * credentials discovered in the bundle are ignored — the caller
   * (`migration-routes.ts`) is responsible for wiring this in PR 5.
   */
  importCredentials?: (
    credentials: Array<{ account: string; value: string }>,
  ) => Promise<void>;
}

/**
 * Stream a `.vbundle` archive from `source` and commit it to disk atomically.
 *
 * Returns an `ImportCommitResult` matching the shape produced by the
 * buffer-based `commitImport`, so callers can treat the two paths
 * interchangeably.
 */
export async function streamCommitImport(
  args: StreamCommitArgs,
): Promise<ImportCommitResult> {
  const { source, pathResolver, workspaceDir, onProgress, importCredentials } =
    args;

  const realWorkspaceDir = resolve(workspaceDir);
  const tempWorkspaceDir = `${realWorkspaceDir}.import-${randomUUID()}`;

  let manifest: ManifestType | null = null;
  const importedFiles: ImportedFileReport[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  // Credential bodies are small (API keys / tokens) — safe to buffer in
  // memory. They intentionally never touch disk: DefaultPathResolver returns
  // null for `credentials/*`, and CES is the only consumer.
  const bufferedCredentials: Array<{ account: string; value: string }> = [];
  // Count entries that actually resulted in a file being written into the
  // temp workspace dir. If zero, we skip the atomic rename pair at the end
  // so the real workspace is left untouched — matches commitImport's
  // "no workspace entries" behavior for legacy bundles / all-skipped bundles.
  let workspaceWrites = 0;

  // Create the temp workspace dir up front so any failure between here and
  // the atomic swap can be cleaned up by the catch block below.
  try {
    await mkdir(tempWorkspaceDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reason: "write_failed",
      message: `Failed to create temp workspace dir "${tempWorkspaceDir}": ${errMessage(err)}`,
    };
  }

  const cleanupTempDir = async (): Promise<void> => {
    try {
      await rm(tempWorkspaceDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(
        { err, tempWorkspaceDir },
        "Failed to clean up temp workspace dir after import failure",
      );
    }
  };

  // Iterate the tar stream. Any error from gzip/tar/source bubbles out of
  // the generator and lands in the catch block below.
  let entryIndex = 0;
  try {
    const entries = parseVBundleStream(source);
    let expected: Map<string, { sha256: string; size: number }> | null = null;

    for await (const entry of entries) {
      if (entryIndex === 0) {
        // First entry MUST be manifest.json — readAndValidateManifest
        // enforces that and throws StreamingValidationError otherwise.
        const manifestResult = await readAndValidateManifest(entry);
        manifest = manifestResult.manifest;
        expected = manifestResult.expected;
        entryIndex += 1;
        continue;
      }

      // After the manifest we must have `expected` populated.
      if (!manifest || !expected) {
        throw new StreamingValidationError(
          "manifest_not_first",
          "Manifest processing did not complete before subsequent entries",
        );
      }

      const archivePath = entry.header.name;

      if (entry.header.type === "directory") {
        // Best-effort: create the directory inside the temp workspace if it
        // resolves inside `workspaceDir`. Drain the empty body either way.
        entry.body.resume();
        const dirResolved = resolveInsideTempWorkspace(
          archivePath,
          pathResolver,
          realWorkspaceDir,
          tempWorkspaceDir,
        );
        if (dirResolved) {
          try {
            await mkdir(dirResolved, { recursive: true });
          } catch (err) {
            throw wrapWriteError(
              `Failed to create directory "${dirResolved}"`,
              err,
            );
          }
        }
        entryIndex += 1;
        continue;
      }

      if (entry.header.type !== "file") {
        // pax-header / other — drain and skip. Non-file payloads are
        // metadata for the tar extractor itself, not user data.
        entry.body.resume();
        entryIndex += 1;
        continue;
      }

      const expectedEntry = expected.get(archivePath);
      if (!expectedEntry) {
        // Bundle contains a file the manifest didn't declare. Destroy the
        // body so the extractor aborts promptly.
        entry.body.destroy();
        throw new StreamingValidationError(
          "manifest_mismatch",
          `Archive entry "${archivePath}" is not declared in the manifest`,
          archivePath,
        );
      }

      if (archivePath.startsWith("credentials/")) {
        // Credentials are hash-verified against the manifest but collected
        // in memory rather than written to disk. DefaultPathResolver
        // deliberately returns null for these paths.
        const buffered = await collectHashVerified(entry.body, {
          sha256: expectedEntry.sha256,
          size: expectedEntry.size,
          archivePath,
        });
        const account = archivePath.slice("credentials/".length);
        if (account) {
          bufferedCredentials.push({
            account,
            value: new TextDecoder().decode(buffered),
          });
        }
        seen.add(archivePath);
        onProgress?.({
          archivePath,
          bytesWritten: expectedEntry.size,
          entryIndex,
        });
        entryIndex += 1;
        continue;
      }

      const diskPath = pathResolver.resolve(archivePath);
      if (!diskPath) {
        // Unknown destination. Consume bytes through the verifier anyway so
        // we still catch manifest/content mismatches, but don't write.
        // Tracking this in the report matches the buffer-based importer's
        // "skipped" semantics.
        await drainThroughVerifier(entry.body, {
          sha256: expectedEntry.sha256,
          size: expectedEntry.size,
          archivePath,
        });
        importedFiles.push({
          path: archivePath,
          disk_path: "",
          action: "skipped",
          size: expectedEntry.size,
          sha256: expectedEntry.sha256,
          backup_path: null,
        });
        warnings.push(
          `Skipped "${archivePath}": no known disk target for this archive path`,
        );
        seen.add(archivePath);
        onProgress?.({
          archivePath,
          bytesWritten: expectedEntry.size,
          entryIndex,
        });
        entryIndex += 1;
        continue;
      }

      // Legacy guardian persona (prompts/USER.md) is translated to the
      // current guardian's users/<slug>.md by DefaultPathResolver. If
      // that target already holds user-authored content, skip rather
      // than clobber — the user has curated their persona since the
      // bundle was exported. We check against the LIVE workspace path
      // (diskPath) because the swap hasn't happened yet.
      if (
        archivePath === LEGACY_USER_MD_ARCHIVE_PATH &&
        isGuardianPersonaCustomized(diskPath)
      ) {
        log.warn(
          { archivePath, diskPath },
          "Skipping legacy prompts/USER.md import: guardian persona is already customized",
        );
        await drainThroughVerifier(entry.body, {
          sha256: expectedEntry.sha256,
          size: expectedEntry.size,
          archivePath,
        });
        importedFiles.push({
          path: archivePath,
          disk_path: diskPath,
          action: "skipped",
          size: expectedEntry.size,
          sha256: expectedEntry.sha256,
          backup_path: null,
        });
        warnings.push(
          `Skipped "${archivePath}": guardian persona at "${diskPath}" is already customized`,
        );
        seen.add(archivePath);
        onProgress?.({
          archivePath,
          bytesWritten: expectedEntry.size,
          entryIndex,
        });
        entryIndex += 1;
        continue;
      }

      // Rebase the resolved path onto the temp workspace.
      const tempDiskPath = rebaseOntoTempWorkspace(
        diskPath,
        realWorkspaceDir,
        tempWorkspaceDir,
      );
      if (!tempDiskPath) {
        // Resolved outside the workspace directory. Not supported for the
        // streaming atomic-swap path — write through the verifier but flag
        // as skipped.
        await drainThroughVerifier(entry.body, {
          sha256: expectedEntry.sha256,
          size: expectedEntry.size,
          archivePath,
        });
        importedFiles.push({
          path: archivePath,
          disk_path: diskPath,
          action: "skipped",
          size: expectedEntry.size,
          sha256: expectedEntry.sha256,
          backup_path: null,
        });
        warnings.push(
          `Skipped "${archivePath}": disk target "${diskPath}" falls outside the workspace directory`,
        );
        seen.add(archivePath);
        onProgress?.({
          archivePath,
          bytesWritten: expectedEntry.size,
          entryIndex,
        });
        entryIndex += 1;
        continue;
      }

      try {
        await mkdir(dirname(tempDiskPath), { recursive: true });
      } catch (err) {
        throw wrapWriteError(
          `Failed to create parent directory for "${tempDiskPath}"`,
          err,
        );
      }

      // Config files need sanitization before writing to strip
      // environment-specific fields (defense-in-depth; matches commitImport).
      // Configs are small (KB-scale) so buffering them is fine. Hash
      // verification still runs on the RAW bytes — the manifest declares the
      // sha/size of the archive content, not the sanitized output.
      if (CONFIG_ARCHIVE_PATHS.has(archivePath)) {
        const rawBytes = await collectHashVerified(entry.body, {
          sha256: expectedEntry.sha256,
          size: expectedEntry.size,
          archivePath,
        });
        const sanitized = sanitizeConfigForTransfer(
          new TextDecoder().decode(rawBytes),
        );
        const sanitizedBytes = new TextEncoder().encode(sanitized);
        try {
          await writeFile(tempDiskPath, sanitizedBytes, { mode: 0o600 });
        } catch (err) {
          throw wrapWriteError(`Failed to write "${tempDiskPath}"`, err);
        }
        importedFiles.push({
          path: archivePath,
          disk_path: diskPath,
          action: "created",
          // Report the sanitized on-disk size, not the archive's raw size —
          // matches what commitImport reports.
          size: sanitizedBytes.length,
          sha256: expectedEntry.sha256,
          backup_path: null,
        });
        workspaceWrites += 1;
        seen.add(archivePath);
        onProgress?.({
          archivePath,
          bytesWritten: expectedEntry.size,
          entryIndex,
        });
        entryIndex += 1;
        continue;
      }

      const verifier = createHashVerifier({
        sha256: expectedEntry.sha256,
        size: expectedEntry.size,
        archivePath,
      });
      const writeStream = createWriteStream(tempDiskPath, { mode: 0o600 });
      try {
        await pipeline(entry.body, verifier, writeStream);
      } catch (err) {
        // Disambiguate between hash/size validation failures and raw disk
        // write errors so the caller sees the right reason code.
        if (err instanceof StreamingValidationError) {
          throw err;
        }
        throw wrapWriteError(`Failed to write "${tempDiskPath}"`, err);
      }

      // Action is always "created" in the streaming path because we're
      // writing into an empty temp workspace. After the swap the effect on
      // the real workspace is functionally "overwrite" at the directory
      // level, but per-file this is the right label — the existing
      // workspace is replaced wholesale, not patched in place.
      const action: ImportFileAction = "created";
      importedFiles.push({
        path: archivePath,
        disk_path: diskPath,
        action,
        size: expectedEntry.size,
        sha256: expectedEntry.sha256,
        backup_path: null,
      });
      workspaceWrites += 1;
      seen.add(archivePath);
      onProgress?.({
        archivePath,
        bytesWritten: expectedEntry.size,
        entryIndex,
      });
      entryIndex += 1;
    }

    // Manifest must have been processed.
    if (!manifest || !expected) {
      throw new StreamingValidationError(
        "manifest_not_first",
        "Archive contained no entries",
      );
    }

    // Every declared manifest path must have been seen in the tar stream.
    const missing: string[] = [];
    for (const path of expected.keys()) {
      if (!seen.has(path)) missing.push(path);
    }
    if (missing.length > 0) {
      throw new StreamingValidationError(
        "missing_entry",
        `Bundle is missing ${missing.length} declared entr${
          missing.length === 1 ? "y" : "ies"
        }: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`,
        missing[0],
      );
    }
  } catch (err) {
    await cleanupTempDir();
    return mapThrownToResult(err);
  }

  // -------------------------------------------------------------------------
  // Atomic swap
  // -------------------------------------------------------------------------

  // If the bundle contained zero entries that resolved into the workspace
  // (legacy-format bundle with no workspace/ entries, or every entry was
  // skipped as out-of-workspace / credential / customized-persona), the
  // temp tree is empty/incomplete. Swapping it in would erase unrelated
  // existing workspace state, so skip the rename pair entirely — matches
  // commitImport, which never clears the workspace without workspace/
  // entries to replace.
  if (workspaceWrites === 0) {
    await cleanupTempDir();

    // Post-commit side effects still run for things like credential import.
    if (importCredentials && bufferedCredentials.length > 0) {
      try {
        await importCredentials(bufferedCredentials);
      } catch (err) {
        log.warn(
          { err, count: bufferedCredentials.length },
          "Post-commit credential import failed",
        );
        warnings.push(`Credential import failed: ${errMessage(err)}`);
      }
    }

    const report = buildReport(manifest, importedFiles, warnings);
    return { ok: true, report };
  }

  // Close the live SQLite connection so the DB file inside the real
  // workspace can be replaced. The singleton lazily reopens on next use.
  try {
    resetDb();
  } catch (err) {
    // resetDb close failure is extremely unlikely but not worth aborting
    // over — log and continue.
    log.warn({ err }, "resetDb threw before swap; continuing");
  }

  const backupDir = `${realWorkspaceDir}.pre-import-${Date.now()}`;
  let realDirRenamedToBackup = false;
  try {
    try {
      await rename(realWorkspaceDir, backupDir);
      realDirRenamedToBackup = true;
    } catch (err) {
      // Real workspace didn't exist. Proceed straight to the second rename.
      if (!isENOENT(err)) {
        await cleanupTempDir();
        return {
          ok: false,
          reason: "write_failed",
          message: `Failed to move real workspace out of the way: ${errMessage(err)}`,
        };
      }
    }

    try {
      await rename(tempWorkspaceDir, realWorkspaceDir);
    } catch (err) {
      // Try to put the original workspace back.
      if (realDirRenamedToBackup) {
        try {
          await rename(backupDir, realWorkspaceDir);
        } catch (restoreErr) {
          log.error(
            { restoreErr, backupDir, realWorkspaceDir },
            "Failed to restore real workspace from backup after import swap failed — manual recovery may be required",
          );
        }
      }
      await cleanupTempDir();
      return {
        ok: false,
        reason: "write_failed",
        message: `Failed to swap temp workspace into place: ${errMessage(err)}`,
      };
    }
  } catch (err) {
    await cleanupTempDir();
    return {
      ok: false,
      reason: "write_failed",
      message: `Workspace swap failed: ${errMessage(err)}`,
    };
  }

  // -------------------------------------------------------------------------
  // Post-commit side effects (non-fatal)
  //
  // Past this point the real workspace is already replaced — failures here
  // do not justify reverting the whole import. Log loudly, surface warnings
  // in the report, return success.
  // -------------------------------------------------------------------------

  if (importCredentials && bufferedCredentials.length > 0) {
    try {
      await importCredentials(bufferedCredentials);
    } catch (err) {
      log.warn(
        { err, count: bufferedCredentials.length },
        "Post-commit credential import failed",
      );
      warnings.push(`Credential import failed: ${errMessage(err)}`);
    }
  }

  try {
    invalidateConfigCache();
  } catch (err) {
    log.warn({ err }, "invalidateConfigCache threw after import");
  }

  try {
    clearTrustCache();
  } catch (err) {
    log.warn({ err }, "clearTrustCache threw after import");
  }

  // Attempt to remove the backup dir (best-effort). Leaving it around is not
  // a correctness issue, only a disk-space one, so we swallow errors.
  if (realDirRenamedToBackup) {
    rm(backupDir, { recursive: true, force: true }).catch((err) => {
      log.warn({ err, backupDir }, "Failed to remove pre-import backup dir");
    });
  }

  const report = buildReport(manifest, importedFiles, warnings);
  return { ok: true, report };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildReport(
  manifest: ManifestType,
  files: ImportedFileReport[],
  warnings: string[],
): ImportCommitReport {
  return {
    success: true,
    summary: {
      total_files: files.length,
      files_created: files.filter((f) => f.action === "created").length,
      files_overwritten: files.filter((f) => f.action === "overwritten").length,
      files_skipped: files.filter((f) => f.action === "skipped").length,
      backups_created: files.filter((f) => f.backup_path !== null).length,
    },
    files,
    manifest,
    warnings,
  };
}

/**
 * Resolve an archive path through the caller's resolver, then rebase the
 * returned disk path onto the temp workspace. Returns `null` when the path
 * cannot be resolved or lands outside `realWorkspaceDir`.
 */
function resolveInsideTempWorkspace(
  archivePath: string,
  pathResolver: PathResolver,
  realWorkspaceDir: string,
  tempWorkspaceDir: string,
): string | null {
  const resolved = pathResolver.resolve(archivePath);
  if (!resolved) return null;
  return rebaseOntoTempWorkspace(resolved, realWorkspaceDir, tempWorkspaceDir);
}

/**
 * Replace the `realWorkspaceDir` prefix of `diskPath` with `tempWorkspaceDir`.
 * Returns null if `diskPath` is not inside `realWorkspaceDir`.
 */
function rebaseOntoTempWorkspace(
  diskPath: string,
  realWorkspaceDir: string,
  tempWorkspaceDir: string,
): string | null {
  const resolved = resolve(diskPath);
  const root = resolve(realWorkspaceDir);
  if (resolved === root) return resolve(tempWorkspaceDir);
  const prefix = root + sep;
  if (!resolved.startsWith(prefix)) return null;
  return resolve(tempWorkspaceDir, resolved.slice(prefix.length));
}

/** Drain an entry body through the hash verifier, discarding the output. */
async function drainThroughVerifier(
  body: Readable,
  expected: { sha256: string; size: number; archivePath: string },
): Promise<void> {
  const verifier = createHashVerifier(expected);
  body.pipe(verifier);
  for await (const _chunk of verifier) {
    // Intentional discard — we only care about the hash/size check that
    // runs in verifier's _flush.
  }
}

/** Collect an entry body into a Buffer, verifying hash+size along the way. */
async function collectHashVerified(
  body: Readable,
  expected: { sha256: string; size: number; archivePath: string },
): Promise<Buffer> {
  const verifier = createHashVerifier(expected);
  body.pipe(verifier);
  const chunks: Buffer[] = [];
  for await (const chunk of verifier) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Map a thrown error from streaming orchestration into an ImportCommitResult. */
function mapThrownToResult(err: unknown): ImportCommitResult {
  if (err instanceof StreamingValidationError) {
    return {
      ok: false,
      reason: "validation_failed",
      errors: [
        {
          code: err.code,
          message: err.message,
          ...(err.archivePath !== undefined ? { path: err.archivePath } : {}),
        },
      ],
    };
  }

  // Errors we raised ourselves for disk-side failures.
  if (err instanceof WriteFailedError) {
    return {
      ok: false,
      reason: "write_failed",
      message: err.message,
    };
  }

  // Anything else bubbling out of the tar / gunzip / HTTP stream pipeline:
  // treat as extraction_failed. This matches the buffer-based validator's
  // gzip/tar parse errors.
  return {
    ok: false,
    reason: "extraction_failed",
    message: errMessage(err),
  };
}

/** Sentinel error for disk I/O failures during streaming. */
class WriteFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteFailedError";
  }
}

function wrapWriteError(prefix: string, cause: unknown): WriteFailedError {
  return new WriteFailedError(`${prefix}: ${errMessage(cause)}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}
