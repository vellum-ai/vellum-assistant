/**
 * Streaming `.vbundle` importer.
 *
 * Buffer-based `commitImport` decompresses the whole archive into RAM and
 * re-walks the tar to write each file — fine for small bundles, OOMs on an
 * 8 GB bundle running on a 3 GB pod. This module orchestrates the streaming
 * primitives (`parseVBundleStream`, `readAndValidateManifest`,
 * `createHashVerifier`) to import a bundle with peak memory bounded by
 * "one tar entry size", not bundle size.
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

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type Readable, Writable } from "node:stream";
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
  WORKSPACE_PRESERVE_PATHS,
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
// Resource ceilings
//
// These cap the streaming importer's exposure to attacker-controlled bundle
// inputs (e.g. a signed-URL migration from an untrusted source). Both caps
// are exposed as optional `opts.maxBundleBytes` / `opts.maxBundleEntries`
// parameters so tests can exercise the abort path with small fixtures —
// production callers should omit the opts and rely on the defaults.
// ---------------------------------------------------------------------------

/**
 * Byte ceiling for the cumulative size of all file data streamed from the
 * bundle. 16 GiB gives comfortable headroom over the 8 GB product limit
 * while still bounding worst-case disk use for the temp workspace.
 */
const DEFAULT_MAX_BUNDLE_BYTES = 16 * 1024 * 1024 * 1024;

/**
 * Entry-count ceiling for the bundle. 100k is well above the largest
 * workspace we ship; anything past that is almost certainly an attack or
 * a corrupted archive.
 */
const DEFAULT_MAX_BUNDLE_ENTRIES = 100_000;

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
   * (`migration-routes.ts`) is responsible for wiring this.
   */
  importCredentials?: (
    credentials: Array<{ account: string; value: string }>,
  ) => Promise<void>;
  /**
   * Test-only override for the bundle-size ceiling (bytes). Production
   * callers should omit this and rely on the 16 GiB default.
   */
  maxBundleBytes?: number;
  /**
   * Test-only override for the entry-count ceiling. Production callers
   * should omit this and rely on the 100_000 default.
   */
  maxBundleEntries?: number;
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
  const {
    source,
    pathResolver,
    workspaceDir,
    onProgress,
    importCredentials,
    maxBundleBytes,
    maxBundleEntries,
  } = args;

  const bundleByteCap = maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
  const bundleEntryCap = maxBundleEntries ?? DEFAULT_MAX_BUNDLE_ENTRIES;

  const realWorkspaceDir = resolve(workspaceDir);

  // Replay recovery from any prior interrupted import BEFORE we stage new
  // data. If a previous streamCommitImport was killed between carry-over
  // and the atomic swap, the live workspace is missing preserved paths
  // (they were moved to an `.import-<uuid>` temp tree). The marker
  // persisted below is what recoverInterruptedImport reads to move them
  // back. Failure to recover is logged but non-fatal — we want the new
  // import to proceed so operators aren't stuck.
  try {
    await recoverInterruptedImport(realWorkspaceDir);
  } catch (err) {
    log.warn(
      { err, realWorkspaceDir },
      "recoverInterruptedImport threw before streaming import; continuing",
    );
  }

  const tempWorkspaceDir = `${realWorkspaceDir}.import-${randomUUID()}`;

  let manifest: ManifestType | null = null;
  const importedFiles: ImportedFileReport[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  // Credential bodies are small (API keys / tokens) — safe to buffer in
  // memory. They intentionally never touch disk: DefaultPathResolver returns
  // null for `credentials/*`, and CES is the only consumer.
  const bufferedCredentials: Array<{ account: string; value: string }> = [];
  // Track whether the bundle contains at least one `workspace/*` entry that
  // resolves to a real disk path. The atomic swap path (which wipes anything
  // outside WORKSPACE_PRESERVE_PATHS) is only safe to take when this is
  // true — it matches commitImport's `hasWorkspaceEntries` gate. Legacy
  // bundles (e.g. `data/db/*`, `config/*`, `prompts/*`, `skills/*` without a
  // workspace/ prefix) fall through to the in-place write path below.
  let hasWorkspaceNamespacedEntry = false;
  // Accumulates the disk paths of files we staged into the temp workspace
  // from legacy-format archive entries. If the bundle turns out to contain
  // NO workspace/ entries we promote each of these into the live workspace
  // with backup-before-overwrite semantics, matching commitImport's legacy
  // handling. Each tuple carries (tempPath, livePath, archivePath, index).
  const legacyStaged: Array<{
    tempPath: string;
    livePath: string;
    archivePath: string;
    importedFileIndex: number;
  }> = [];
  // Cumulative manifest-declared byte total, accumulated BEFORE each entry
  // is read/written. Checked against `bundleByteCap` pre-write so an
  // oversized entry never lands on disk. We count manifest-declared
  // `expectedEntry.size` (the raw archive bytes) rather than on-disk size
  // so a sanitized config still counts against the cap as originally
  // declared.
  let totalBytesStreamed = 0;
  // Number of file/directory entries processed (not counting the manifest).
  // Compared against `bundleEntryCap`.
  let entryCount = 0;

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
        // Entry-count ceiling check. The manifest declares every file the
        // bundle claims to contain, so one check here bounds the work the
        // importer is willing to do for this bundle.
        if (manifest.files.length > bundleEntryCap) {
          throw new StreamingValidationError(
            "bundle_too_many_entries",
            `bundle contains more than ${bundleEntryCap} entries (declared: ${manifest.files.length})`,
          );
        }
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

      // Entry-count ceiling also applies to tar-level entries that arrive
      // in the stream (pax headers, directories, extras). A bundle whose
      // manifest stayed under the cap but whose tar carries padding-style
      // extras is still bounded.
      entryCount += 1;
      if (entryCount > bundleEntryCap) {
        entry.body.destroy();
        throw new StreamingValidationError(
          "bundle_too_many_entries",
          `bundle contains more than ${bundleEntryCap} entries`,
        );
      }

      const archivePath = entry.header.name;

      // Non-file entries are either directory markers (empty body) or
      // pax-header / other metadata payloads we don't consume. Apply the
      // bundle byte cap to their tar-header size too — an attacker could
      // otherwise keep `manifest.files` small while stuffing huge pax/other
      // entry bodies, draining the importer for free. Directory bodies are
      // reliably zero-sized; pax headers are measured in bytes, so this
      // check is effectively free in the happy path.
      if (entry.header.type !== "file") {
        const nonFileSize = entry.header.size ?? 0;
        if (totalBytesStreamed + nonFileSize > bundleByteCap) {
          entry.body.destroy();
          throw new StreamingValidationError(
            "bundle_too_large",
            `bundle exceeds ${bundleByteCap}-byte ceiling (non-file entry "${archivePath}" size ${nonFileSize})`,
            archivePath,
          );
        }
        totalBytesStreamed += nonFileSize;
      }

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

      // Reject tar entries whose declared size disagrees with the manifest.
      // The bundle-size ceiling below trusts `expectedEntry.size`; if a
      // crafted bundle declared a tiny size in `manifest.json` but carried a
      // huge body in the tar header, the cap would pass and the oversized
      // payload would still stream to disk. `createHashVerifier` already
      // fails on size mismatch at stream end, but by then the bytes have
      // already been written. Fail fast here so no oversized payload lands
      // on disk.
      if (entry.header.size !== expectedEntry.size) {
        entry.body.destroy();
        throw new StreamingValidationError(
          "entry_size",
          `Archive entry "${archivePath}" has tar-header size ${entry.header.size} but manifest declares ${expectedEntry.size}`,
          archivePath,
        );
      }

      // Enforce the bundle-size ceiling BEFORE writing/consuming the entry.
      // Checking post-write would still let a single oversized file land on
      // disk before we reject, defeating the cap as a resource guard. We
      // check both the manifest-declared size (what we just verified the
      // tar agrees with) AND the tar-header size directly, using whichever
      // is larger, so a future header/manifest desync can't slip through.
      const declaredSize = Math.max(entry.header.size, expectedEntry.size);
      if (totalBytesStreamed + declaredSize > bundleByteCap) {
        entry.body.destroy();
        throw new StreamingValidationError(
          "bundle_too_large",
          `bundle exceeds ${bundleByteCap}-byte ceiling`,
          archivePath,
        );
      }
      totalBytesStreamed += declaredSize;

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

      // Classify the entry as `workspace/*` (namespaced) vs legacy format.
      // Namespaced entries flip the swap-gate flag; legacy entries are
      // staged for an in-place promote after the stream completes.
      const isWorkspaceNamespaced = archivePath.startsWith("workspace/");

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
        // commitImport reports the sha256 of the bytes actually written to
        // disk (which differs from the manifest-declared sha once
        // sanitization strips fields). Mirror that here so downstream
        // integrity re-checks against the on-disk file succeed.
        const onDiskSha = sha256Hex(sanitizedBytes);
        const importedFileIndex = importedFiles.length;
        importedFiles.push({
          path: archivePath,
          disk_path: diskPath,
          action: "created",
          // Report the sanitized on-disk size, not the archive's raw size —
          // matches what commitImport reports.
          size: sanitizedBytes.length,
          sha256: onDiskSha,
          backup_path: null,
        });
        if (isWorkspaceNamespaced) {
          hasWorkspaceNamespacedEntry = true;
        } else {
          legacyStaged.push({
            tempPath: tempDiskPath,
            livePath: diskPath,
            archivePath,
            importedFileIndex,
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

      // Action is "created" for the in-temp-tree record. Whether the real
      // workspace sees this as create vs overwrite is resolved later: the
      // atomic-swap path wipes and replaces wholesale, while the legacy
      // in-place promote checks against the live file and flips the action
      // to "overwritten" with a backup.
      const action: ImportFileAction = "created";
      const importedFileIndex = importedFiles.length;
      importedFiles.push({
        path: archivePath,
        disk_path: diskPath,
        action,
        size: expectedEntry.size,
        sha256: expectedEntry.sha256,
        backup_path: null,
      });
      if (isWorkspaceNamespaced) {
        hasWorkspaceNamespacedEntry = true;
      } else {
        legacyStaged.push({
          tempPath: tempDiskPath,
          livePath: diskPath,
          archivePath,
          importedFileIndex,
        });
      }
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
  // Commit strategy selection
  //
  // commitImport's in-place path only clears the workspace when the bundle
  // carries at least one `workspace/*` entry that resolves to a real disk
  // path — legacy-format bundles (`data/db/*`, `config/*`, `prompts/*`,
  // `skills/*`, `hooks/*` without a workspace/ prefix) write individual
  // files in place without wiping siblings. The streaming importer's
  // atomic-swap path is equivalent to the selective-clear-and-write path;
  // it must therefore only fire when `hasWorkspaceNamespacedEntry` is
  // true. For legacy-only bundles we promote staged temp files into the
  // live workspace one by one with backup-before-overwrite semantics.
  // -------------------------------------------------------------------------

  // Empty result: no writable entries, no staged legacy files. Skip both
  // commit paths — nothing can alter the live workspace. This matches
  // commitImport's no-op behavior for all-credential or all-skipped
  // bundles.
  if (!hasWorkspaceNamespacedEntry && legacyStaged.length === 0) {
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

  // Legacy-only bundle: we have files staged under the temp workspace but
  // no `workspace/*` entries telling us the caller wants to replace the
  // entire workspace. Promote each staged file into the live workspace in
  // place, matching commitImport's legacy branch (backup-before-overwrite,
  // parent-dir mkdir, no workspace-wide clear). The temp workspace is
  // removed when done — it only served as a landing zone for the verified
  // hash stream.
  if (!hasWorkspaceNamespacedEntry) {
    // Close the live SQLite connection before promoting staged files. A
    // legacy bundle may carry `data/db/assistant.db`, and replacing the file
    // with an open connection leaves the daemon pinned to the old inode —
    // subsequent reads/writes would go against stale pre-import data until
    // the process reset the connection. The singleton lazily reopens on next
    // use, so closing here is safe even if no DB entry is in the bundle.
    try {
      resetDb();
    } catch (err) {
      log.warn(
        { err },
        "resetDb threw before legacy-format import promotion; continuing",
      );
    }

    try {
      await promoteLegacyStagedFiles(legacyStaged, importedFiles);
    } catch (err) {
      await cleanupTempDir();
      return {
        ok: false,
        reason: "write_failed",
        message: `Failed to promote legacy-format import into workspace: ${errMessage(err)}`,
      };
    }

    await cleanupTempDir();

    // Post-commit side effects. Config/trust caches can still be stale
    // from a legacy config/settings.json write, and credentials still
    // need to flow through CES.
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
      log.warn({ err }, "invalidateConfigCache threw after legacy import");
    }

    try {
      clearTrustCache();
    } catch (err) {
      log.warn({ err }, "clearTrustCache threw after legacy import");
    }

    const report = buildReport(manifest, importedFiles, warnings);
    return { ok: true, report };
  }

  // Atomic swap path for workspace/*-carrying bundles.

  // Close the live SQLite connection so the DB file inside the real
  // workspace can be replaced. The singleton lazily reopens on next use.
  try {
    resetDb();
  } catch (err) {
    // resetDb close failure is extremely unlikely but not worth aborting
    // over — log and continue.
    log.warn({ err }, "resetDb threw before swap; continuing");
  }

  // Carry-over: for every path in WORKSPACE_PRESERVE_PATHS, if the bundle
  // did NOT populate it inside the temp workspace but the LIVE workspace
  // has it, move the live copy into the temp workspace at the same
  // relative location. Without this step the atomic swap erases live
  // user data (SQLite DB, Qdrant store, embedding-models cache,
  // deprecated/ quarantine) whenever the bundle omits those paths —
  // e.g. partial bundles carrying only prompts/config.
  //
  // Carry-over uses `rename` (not `cp`) to stay zero-disk on the happy
  // path, which is critical on instances with multi-GB Qdrant stores or
  // SQLite DBs and limited free space.
  //
  // Crash-safety is achieved in two phases:
  //   1. `planCarryOverPreservedPaths` walks the live + temp trees WITHOUT
  //      mutating anything and produces the full intended `carried` list.
  //   2. `writeImportMarker` persists that plan to disk BEFORE any rename
  //      runs. If the process dies during the subsequent
  //      `executeCarryOverPlan`, the marker already holds every
  //      (liveChild, tempChild) pair the next `recoverInterruptedImport`
  //      needs to replay. The marker is deleted only after the atomic
  //      swap pair succeeds (or in-process failure paths explicitly
  //      restore state).
  let carried: CarriedPath[];
  try {
    carried = await planCarryOverPreservedPaths(
      realWorkspaceDir,
      tempWorkspaceDir,
    );
  } catch (err) {
    await cleanupTempDir();
    return {
      ok: false,
      reason: "write_failed",
      message: `Failed to plan preserved-path carry-over: ${errMessage(err)}`,
    };
  }

  const markerPath = importMarkerPathFor(realWorkspaceDir);
  try {
    await writeImportMarker(markerPath, {
      tempWorkspaceDir,
      carried: carried.map((c) => ({
        liveChild: c.liveChild,
        tempChild: c.tempChild,
      })),
    });
  } catch (err) {
    // Persisting the recovery plan is a prerequisite for crash-safe
    // carry-over. If we can't write the marker, refuse to mutate the live
    // workspace — a mid-carryover crash would otherwise be unrecoverable.
    await cleanupTempDir();
    return {
      ok: false,
      reason: "write_failed",
      message: `Failed to persist import recovery marker: ${errMessage(err)}`,
    };
  }

  try {
    await executeCarryOverPlan(carried);
  } catch (err) {
    // A rename in the plan failed. Restore the already-moved entries so
    // the live workspace is whole again, then delete the marker and temp
    // dir. `restoreCarriedPaths` is a no-op on entries that were never
    // moved (tempChild missing), so passing the full plan is safe.
    await restoreCarriedPaths(carried);
    await safelyDeleteMarker(markerPath);
    await cleanupTempDir();
    return {
      ok: false,
      reason: "write_failed",
      message: `Failed to carry over preserved workspace paths: ${errMessage(err)}`,
    };
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
        // `rename(real → backup)` failed, so the live workspace still
        // exists — but carried preserved paths are now in the temp tree,
        // about to be deleted. Restore them to live before bailing out.
        await restoreCarriedPaths(carried);
        await cleanupTempDir();
        await safelyDeleteMarker(markerPath);
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
      // The backup we just restored (if we did) was captured AFTER the
      // carry-over already moved preserved paths into temp, so it's
      // missing SQLite/Qdrant/embedding-models/deprecated. Move them back
      // from temp to the (now restored) live workspace before temp gets
      // deleted.
      await restoreCarriedPaths(carried);
      await cleanupTempDir();
      await safelyDeleteMarker(markerPath);
      return {
        ok: false,
        reason: "write_failed",
        message: `Failed to swap temp workspace into place: ${errMessage(err)}`,
      };
    }

    // Rename pair completed successfully. Clear the recovery marker so a
    // subsequent `recoverInterruptedImport` call on a future start-up
    // doesn't see a stale entry.
    await safelyDeleteMarker(markerPath);
  } catch (err) {
    await cleanupTempDir();
    await safelyDeleteMarker(markerPath);
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

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function generateBackupPath(diskPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${diskPath}.backup-${timestamp}`;
}

/**
 * Promote verified-into-temp files for a legacy-format bundle into the
 * live workspace in place. Mirrors commitImport's legacy write path:
 *
 *   - If the live path already exists, copy it to a timestamped
 *     `${livePath}.backup-<ts>` sibling first.
 *   - Ensure the parent directory exists.
 *   - `fs.rename` the temp file over the live path for per-file atomicity.
 *     If that fails with EXDEV (cross-filesystem), fall back to `copyFile`
 *     then `rm` of the temp source.
 *   - Update the corresponding `ImportedFileReport` with the overwrite
 *     action and backup path so the report matches commitImport's output.
 */
async function promoteLegacyStagedFiles(
  staged: Array<{
    tempPath: string;
    livePath: string;
    archivePath: string;
    importedFileIndex: number;
  }>,
  importedFiles: ImportedFileReport[],
): Promise<void> {
  for (const entry of staged) {
    // Backup before overwrite, matching commitImport.
    let backupPath: string | null = null;
    if (existsSync(entry.livePath)) {
      backupPath = generateBackupPath(entry.livePath);
      await copyFile(entry.livePath, backupPath);
    }

    await mkdir(dirname(entry.livePath), { recursive: true });

    try {
      await rename(entry.tempPath, entry.livePath);
    } catch (err) {
      if (isEXDEV(err)) {
        await copyFile(entry.tempPath, entry.livePath);
        await rm(entry.tempPath, { force: true });
      } else {
        throw err;
      }
    }

    const report = importedFiles[entry.importedFileIndex];
    if (report) {
      if (backupPath) {
        report.action = "overwritten";
        report.backup_path = backupPath;
      } else {
        report.action = "created";
      }
    }
  }
}

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
 * Copy any WORKSPACE_PRESERVE_PATHS entries from the live workspace into
 * the temp workspace when the bundle did not already populate them. Runs
 * immediately before the atomic swap so the swap-in tree has the union
 * of bundle-provided files and live-preserved files.
 *
 * Per-file merge semantics (critical): a bundle that touches a SINGLE file
 * under a preserved directory (e.g. writes `workspace/data/qdrant/config.json`)
 * must NOT cause the rest of that directory to be wiped. We therefore walk
 * each preserved path recursively and carry over any live file or
 * subdirectory the bundle did not itself write. A whole-directory short-
 * circuit would mis-handle that case by erasing unrelated qdrant segments,
 * DB WALs, embedding-model shards, etc.
 *
 * For each preserved relative path:
 *   - If the preserved path is a FILE in the live workspace and the temp
 *     tree already has that exact path, the bundle populated it — leave
 *     it alone. Otherwise rename/copy the live file over.
 *   - If the preserved path is a DIRECTORY in the live workspace, walk
 *     it recursively. For each entry:
 *       * If the temp tree has a matching entry at the same relative
 *         path, the bundle wrote it — skip.
 *       * If not, carry the live entry over (rename with EXDEV fallback
 *         to recursive copy).
 *     The walk stops descending on any subtree the bundle has completely
 *     populated, since we only need to fill gaps.
 */
/**
 * Pre-compute the full `CarriedPath[]` that `carryOverPreservedPaths` will
 * move, WITHOUT mutating the live workspace. The result lets us write the
 * crash-recovery marker before any rename runs, so a crash mid-carry-over
 * still leaves a complete restoration plan for the next
 * `recoverInterruptedImport` call.
 *
 * The walk mirrors `carryOverPreservedPaths` exactly — if the two were to
 * disagree, recovery would be incomplete. Directory subtrees that the
 * bundle didn't populate are recorded as a single top-level move (matches
 * the one-shot rename the executor does); per-file merges happen otherwise.
 */
async function planCarryOverPreservedPaths(
  realWorkspaceDir: string,
  tempWorkspaceDir: string,
): Promise<CarriedPath[]> {
  const plan: CarriedPath[] = [];
  for (const rel of WORKSPACE_PRESERVE_PATHS) {
    const livePath = join(realWorkspaceDir, rel);
    const tempPath = join(tempWorkspaceDir, rel);

    let liveStat;
    try {
      liveStat = await stat(livePath);
    } catch (err) {
      if (isENOENT(err)) continue;
      throw err;
    }

    if (!liveStat.isDirectory()) {
      if (existsSync(tempPath)) continue;
      plan.push({ liveChild: livePath, tempChild: tempPath });
      continue;
    }

    await planMergeLiveIntoTempDir(livePath, tempPath, plan);
  }
  return plan;
}

/**
 * Same walk as `mergeLiveIntoTempDir` but only records the would-be moves
 * in `plan`. Intentionally side-effect-free apart from appending to the
 * plan array.
 */
async function planMergeLiveIntoTempDir(
  liveDir: string,
  tempDir: string,
  plan: CarriedPath[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(liveDir, { withFileTypes: true });
  } catch (err) {
    if (isENOENT(err)) return;
    throw err;
  }

  for (const entry of entries) {
    const liveChild = join(liveDir, entry.name);
    const tempChild = join(tempDir, entry.name);
    const existsInTemp = existsSync(tempChild);

    if (entry.isDirectory()) {
      if (!existsInTemp) {
        plan.push({ liveChild, tempChild });
        continue;
      }
      await planMergeLiveIntoTempDir(liveChild, tempChild, plan);
      continue;
    }

    if (existsInTemp) continue;
    plan.push({ liveChild, tempChild });
  }
}

/**
 * Execute a carry-over plan produced by `planCarryOverPreservedPaths`.
 * Each entry is moved with `carryOverEntry`; directories that are plan
 * roots have their parent created so `rename` can land them.
 *
 * Per-entry failures abort the loop and throw — the caller is expected to
 * run `restoreCarriedPaths` on the already-moved entries (a subset of the
 * plan) on its in-process failure path.
 */
async function executeCarryOverPlan(plan: CarriedPath[]): Promise<void> {
  for (const { liveChild, tempChild } of plan) {
    await mkdir(dirname(tempChild), { recursive: true });
    await carryOverEntry(liveChild, tempChild);
  }
}

/**
 * Move a single live workspace entry (file or directory) into the temp
 * workspace. Uses `rename` for the fast path (same-filesystem, zero copy)
 * so we don't duplicate potentially multi-GB preserved trees like
 * `data/qdrant` or `data/db`. Falls back to `cp` + `rm` on EXDEV (different
 * filesystems) — rare in practice since live and temp share a parent dir.
 *
 * Live data is moved, not copied, so the atomic swap must restore it on
 * failure. `streamCommitImport` tracks every carry-over via `CarriedPath`
 * and calls `restoreCarriedPaths` on any swap-pair error so the live
 * workspace ends up whole even if the import aborts.
 */
async function carryOverEntry(
  liveChild: string,
  tempChild: string,
): Promise<void> {
  try {
    await rename(liveChild, tempChild);
  } catch (err) {
    if (isEXDEV(err)) {
      await cp(liveChild, tempChild, {
        recursive: true,
        preserveTimestamps: true,
      });
      await rm(liveChild, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/**
 * Every preserved entry that was moved out of the live workspace during
 * carry-over. Used to undo the move if the atomic swap fails, so we never
 * leave the daemon with SQLite/Qdrant/embedding-model data stranded in a
 * temp tree that's about to be deleted.
 */
interface CarriedPath {
  /** Original location inside the live workspace (real path before swap). */
  liveChild: string;
  /** Landing location inside the temp workspace. */
  tempChild: string;
}

/**
 * Undo a set of carry-over moves by renaming each carried path back to its
 * original live location. Best-effort: logs and continues on per-entry
 * failures rather than throwing, since the caller is already handling a
 * swap-pair failure and needs to restore as much state as possible.
 */
async function restoreCarriedPaths(
  carried: readonly CarriedPath[],
): Promise<void> {
  for (const { liveChild, tempChild } of carried) {
    try {
      await mkdir(dirname(liveChild), { recursive: true });
      await rename(tempChild, liveChild);
    } catch (err) {
      if (isEXDEV(err)) {
        try {
          await cp(tempChild, liveChild, {
            recursive: true,
            preserveTimestamps: true,
          });
          await rm(tempChild, { recursive: true, force: true });
          continue;
        } catch (cpErr) {
          log.error(
            { err: cpErr, liveChild, tempChild },
            "Failed to restore carried preserved path via cp fallback; manual recovery may be required",
          );
          continue;
        }
      }
      if (isENOENT(err)) {
        // The entry may have already moved (rename-pair partially succeeded)
        // or never existed. Nothing to restore.
        continue;
      }
      log.error(
        { err, liveChild, tempChild },
        "Failed to restore carried preserved path; manual recovery may be required",
      );
    }
  }
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

/**
 * Drain an entry body through the hash verifier, discarding the output.
 *
 * Uses `pipeline` (not `.pipe()`) so that if `body` is destroyed mid-stream
 * — e.g. the upstream fetch body is torn down during a URL import — the
 * verifier is destroyed too, and this call rejects promptly instead of
 * hanging on a `for await` that never terminates.
 *
 * A `/dev/null` Writable sink terminates the chain so the verifier's
 * readable side is continuously drained. Without this sink, a Transform as
 * the last pipeline stage would stall once its internal buffer reached
 * `highWaterMark` (16 KB default), since nothing would pull its output,
 * and `pipeline` would hang indefinitely on any skipped entry >~16 KB.
 */
async function drainThroughVerifier(
  body: Readable,
  expected: { sha256: string; size: number; archivePath: string },
): Promise<void> {
  const verifier = createHashVerifier(expected);
  const devNull = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  await pipeline(body, verifier, devNull);
}

/**
 * Hard cap on the per-entry size that `collectHashVerified` is willing to
 * buffer in memory. Applied to credential bodies and config files — both
 * are expected to be KB-scale in practice. Exceeding this cap signals a
 * crafted or corrupted bundle and is rejected before any bytes are read,
 * so the streaming importer's memory guarantees still hold on a 3 GB pod
 * even when the URL import is attacker-controlled.
 */
const MAX_BUFFERED_ENTRY_BYTES = 16 * 1024 * 1024;

/**
 * Collect an entry body into a Buffer, verifying hash+size along the way.
 *
 * Uses `pipeline` + a sink writable that accumulates chunks, so destroy
 * signals propagate the same way as `drainThroughVerifier` and the hash
 * verifier's `_flush` (which asserts size+sha256) always runs.
 *
 * Rejects entries whose manifest-declared size exceeds
 * `MAX_BUFFERED_ENTRY_BYTES` BEFORE reading any bytes, so an oversized
 * credential or config file cannot drive RSS up by `expected.size` on a
 * memory-limited pod.
 */
async function collectHashVerified(
  body: Readable,
  expected: { sha256: string; size: number; archivePath: string },
): Promise<Buffer> {
  if (expected.size > MAX_BUFFERED_ENTRY_BYTES) {
    body.destroy();
    throw new StreamingValidationError(
      "entry_too_large_to_buffer",
      `Archive entry "${expected.archivePath}" declares ${expected.size} bytes, exceeding the ${MAX_BUFFERED_ENTRY_BYTES}-byte in-memory buffer cap for credentials/configs`,
      expected.archivePath,
    );
  }
  const verifier = createHashVerifier(expected);
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  await pipeline(body, verifier, sink);
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

function isEXDEV(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "EXDEV"
  );
}

// ---------------------------------------------------------------------------
// Crash-recovery marker
//
// `streamCommitImport` moves preserved paths (SQLite DB, Qdrant, etc.) from
// the live workspace into a temp tree before the atomic rename pair. If the
// process is killed between those two phases the live workspace comes up
// missing the preserved paths. The marker written here persists the state
// needed to replay the recovery on the next start-up.
//
// Schema stays deliberately small so a partially-written marker is easy to
// detect (JSON parse failure → skip recovery rather than act on garbage).
// ---------------------------------------------------------------------------

interface ImportMarker {
  /** Absolute path of the `.import-<uuid>` temp tree. */
  tempWorkspaceDir: string;
  /** Preserved paths moved out of the live workspace pre-swap. */
  carried: Array<{ liveChild: string; tempChild: string }>;
}

/**
 * Deterministic marker location next to (but not inside) the workspace dir.
 * Putting it outside the workspace means the marker is not swept away by
 * the atomic rename of the workspace itself.
 */
function importMarkerPathFor(realWorkspaceDir: string): string {
  return join(
    dirname(realWorkspaceDir),
    `${basename(realWorkspaceDir)}.import-marker.json`,
  );
}

async function writeImportMarker(
  markerPath: string,
  marker: ImportMarker,
): Promise<void> {
  const serialized = JSON.stringify(marker);
  const tmp = `${markerPath}.tmp-${randomUUID()}`;
  // Write+rename so a crash mid-write leaves either the old marker (or
  // nothing) rather than a truncated JSON blob.
  await writeFile(tmp, serialized, { mode: 0o600 });
  await rename(tmp, markerPath);
}

async function safelyDeleteMarker(markerPath: string): Promise<void> {
  try {
    await unlink(markerPath);
  } catch (err) {
    if (isENOENT(err)) return;
    log.warn({ err, markerPath }, "Failed to delete import-recovery marker");
  }
}

/**
 * Replay any crash-interrupted import against `realWorkspaceDir`.
 *
 * Call at daemon start-up (and implicitly at the start of every
 * `streamCommitImport` as a self-healing belt) so a prior killed import
 * doesn't leave the live workspace missing `data/db` / `data/qdrant` /
 * `embedding-models` / `deprecated`.
 *
 * Best-effort: logs per-entry failures and keeps going rather than
 * throwing. If no marker exists this is a cheap no-op.
 */
export async function recoverInterruptedImport(
  realWorkspaceDir: string,
): Promise<void> {
  const markerPath = importMarkerPathFor(resolve(realWorkspaceDir));
  let raw: string;
  try {
    raw = await readFile(markerPath, "utf8");
  } catch (err) {
    if (isENOENT(err)) return;
    log.warn({ err, markerPath }, "Unable to read import-recovery marker");
    return;
  }

  let marker: ImportMarker;
  try {
    marker = JSON.parse(raw) as ImportMarker;
  } catch (err) {
    log.warn(
      { err, markerPath },
      "Import-recovery marker is malformed; deleting without acting on it",
    );
    await safelyDeleteMarker(markerPath);
    return;
  }

  if (
    !Array.isArray(marker.carried) ||
    typeof marker.tempWorkspaceDir !== "string"
  ) {
    log.warn(
      { markerPath, marker },
      "Import-recovery marker has unexpected shape; deleting",
    );
    await safelyDeleteMarker(markerPath);
    return;
  }

  log.info(
    {
      markerPath,
      tempWorkspaceDir: marker.tempWorkspaceDir,
      carriedCount: marker.carried.length,
    },
    "Recovering from interrupted import: restoring preserved paths",
  );

  await restoreCarriedPaths(
    marker.carried.map((c) => ({
      liveChild: c.liveChild,
      tempChild: c.tempChild,
    })),
  );

  // Clean up the temp tree (best-effort — partial writes there are fine to
  // drop now that preserved paths are back in the live workspace).
  try {
    await rm(marker.tempWorkspaceDir, { recursive: true, force: true });
  } catch (err) {
    log.warn(
      { err, tempWorkspaceDir: marker.tempWorkspaceDir },
      "Failed to clean up temp workspace during import recovery",
    );
  }

  await safelyDeleteMarker(markerPath);
}
