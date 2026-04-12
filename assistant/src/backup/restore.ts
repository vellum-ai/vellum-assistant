/**
 * High-level helpers for restoring and verifying backup snapshots produced
 * by the backup pipeline.
 *
 * A snapshot is one of:
 *   - A plaintext `.vbundle` file (gzipped tar — see `vbundle-builder.ts`).
 *   - An encrypted `.vbundle.enc` file produced by `stream-crypt.encryptFile`.
 *
 * The encryption status is detected purely from the file extension:
 *   - `.vbundle.enc` → encrypted (decryption key required)
 *   - `.vbundle`     → plaintext
 *
 * For encrypted snapshots, this module decrypts to a temporary file under the
 * OS temp directory, runs validation, and then either commits the import or
 * just reports validation status. The temp file is always cleaned up — on
 * success and on failure — via a `try { ... } finally { unlink }` block.
 *
 * Restore is intentionally a thin wrapper around the existing
 * `commitImport` flow in `runtime/migrations/vbundle-importer.ts`. That
 * function handles bundle validation, workspace clearing, per-file
 * backup-before-overwrite, and writing files to disk.
 *
 * IMPORTANT: `commitImport` does NOT reset the live SQLite handle, invalidate
 * cached config, or clear the trust cache. Callers are responsible for:
 *   1. Calling `resetDb()` BEFORE invoking `restoreFromSnapshot` so the
 *      running daemon's DB singleton is closed before the file is overwritten
 *      (otherwise the daemon keeps a handle to the old inode and subsequent
 *      writes can corrupt the restored state).
 *   2. Calling `invalidateConfigCache()` and `clearTrustCache()` AFTER a
 *      successful restore so the daemon re-reads the restored `config.json`
 *      and `trust.json` instead of serving stale in-process caches.
 *   3. Considering a daemon restart as the simplest, most reliable recovery
 *      path — a CLI caller should refuse to restore against a live daemon
 *      unless explicitly forced.
 *
 * Credentials are intentionally excluded from backups — they live in the OS
 * keychain / CES and are not restored by this path. Users re-authenticate
 * integrations after a restore.
 */

import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PathResolver } from "../runtime/migrations/vbundle-import-analyzer.js";
import { commitImport } from "../runtime/migrations/vbundle-importer.js";
import type { ManifestType } from "../runtime/migrations/vbundle-validator.js";
import { validateVBundle } from "../runtime/migrations/vbundle-validator.js";
import { decryptFile } from "./stream-crypt.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Optional injection point for the underlying commit function. Tests pass a
 * fake here to avoid running the destructive `commitImport` flow against the
 * live workspace. Production callers should leave this unset so the real
 * importer is used.
 */
export type CommitImpl = typeof commitImport;

export interface RestoreOptions {
  /** AES-256 decryption key. Required for `.vbundle.enc` snapshots. */
  key?: Buffer;
  /**
   * Resolver that maps archive paths (e.g. `workspace/config.json`) to
   * absolute disk paths. Required by the underlying `commitImport` flow.
   */
  pathResolver: PathResolver;
  /**
   * Absolute path to the workspace directory. When set and the bundle
   * contains `workspace/` entries, `commitImport` clears the workspace
   * before writing to ensure an exact-match restore.
   */
  workspaceDir?: string;
  /**
   * Optional override for the underlying commit function. Tests inject a
   * fake to avoid mutating disk; production callers should leave this unset.
   */
  commitImpl?: CommitImpl;
}

export interface RestoreResult {
  /** Manifest from the bundle that was restored. */
  manifest: ManifestType;
  /** Number of files written (or skipped) by the underlying commit. */
  restoredFiles: number;
}

export interface VerifyOptions {
  /** AES-256 decryption key. Required for `.vbundle.enc` snapshots. */
  key?: Buffer;
}

export interface VerifyResult {
  /** True iff the bundle decrypts (when applicable) and validates. */
  valid: boolean;
  /** Manifest from the bundle when `valid` is true. */
  manifest?: ManifestType;
  /**
   * Human-readable error message when `valid` is false. Populated for
   * validation failures, decryption failures, and missing-file errors.
   * Always undefined when `valid` is true.
   */
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns true if the snapshot path indicates an encrypted bundle. */
function isEncryptedSnapshot(snapshotPath: string): boolean {
  return snapshotPath.endsWith(".vbundle.enc");
}

/** Build a unique temp path for a decrypted bundle. */
function makeDecryptedTempPath(): string {
  return join(tmpdir(), `vellum-restore-${randomUUID()}.vbundle`);
}

/**
 * Resolve `snapshotPath` to a path that holds plaintext `.vbundle` bytes.
 *
 * For plaintext snapshots, this just returns `{ path: snapshotPath }`. For
 * encrypted snapshots, it decrypts to a fresh temp file and returns
 * `{ path: tmpPath, tmpPath }` so the caller can clean up afterwards.
 *
 * Throws when an encrypted bundle has no key, when `decryptFile` fails
 * (bad key, tampered ciphertext, truncated file), or on any I/O error.
 */
async function materializePlaintext(
  snapshotPath: string,
  key: Buffer | undefined,
): Promise<{ path: string; tmpPath: string | null }> {
  if (!isEncryptedSnapshot(snapshotPath)) {
    return { path: snapshotPath, tmpPath: null };
  }

  if (!key) {
    throw new Error("Encrypted snapshot requires a decryption key");
  }

  const tmpPath = makeDecryptedTempPath();
  await decryptFile(snapshotPath, tmpPath, key);
  return { path: tmpPath, tmpPath };
}

/** Best-effort temp file cleanup — swallows ENOENT and other errors. */
async function safeUnlink(path: string | null): Promise<void> {
  if (!path) return;
  try {
    await unlink(path);
  } catch {
    // Best-effort — temp file may already be gone.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Restore a backup snapshot into the workspace.
 *
 * Auto-detects encryption from the file extension. Encrypted snapshots
 * (`.vbundle.enc`) decrypt to a temp file under `tmpdir()` before
 * validation; the temp file is unlinked in a `finally` block so it never
 * lingers, even on validation or commit failure.
 *
 * The actual restore is delegated to `commitImport`, which owns the
 * backup-before-overwrite, workspace-clearing, and integrity-check logic.
 * Tests can pass `opts.commitImpl` to substitute a fake without mutating
 * the live workspace.
 */
export async function restoreFromSnapshot(
  snapshotPath: string,
  opts: RestoreOptions,
): Promise<RestoreResult> {
  const {
    key,
    pathResolver,
    workspaceDir,
    commitImpl = commitImport,
  } = opts;

  let tmpPath: string | null = null;
  try {
    const materialized = await materializePlaintext(snapshotPath, key);
    tmpPath = materialized.tmpPath;

    // Read plaintext bytes for validation + commit. validateVBundle takes
    // raw bytes (Uint8Array) — file paths are not part of its API.
    const fileData = await readFile(materialized.path);

    const validation = validateVBundle(fileData);
    if (!validation.is_valid || !validation.manifest || !validation.entries) {
      const summary = validation.errors
        .map((e) => `${e.code}: ${e.message}`)
        .join("; ");
      throw new Error(`Snapshot failed validation: ${summary}`);
    }

    const commitResult = commitImpl({
      archiveData: fileData,
      pathResolver,
      preValidatedManifest: validation.manifest,
      preValidatedEntries: validation.entries,
      workspaceDir,
    });

    if (!commitResult.ok) {
      // Surface a single error message regardless of which discriminated
      // branch failed — callers in the backup CLI just want a message.
      let message: string;
      switch (commitResult.reason) {
        case "validation_failed":
          message = commitResult.errors
            .map((e) => `${e.code}: ${e.message}`)
            .join("; ");
          break;
        case "extraction_failed":
        case "write_failed":
          message = commitResult.message;
          break;
      }
      throw new Error(`Snapshot restore failed: ${message}`);
    }

    return {
      manifest: commitResult.report.manifest,
      restoredFiles: commitResult.report.summary.total_files,
    };
  } finally {
    await safeUnlink(tmpPath);
  }
}

/**
 * Verify a backup snapshot without restoring it.
 *
 * Auto-detects encryption from the file extension and decrypts to a temp
 * file when needed (cleaned up in a `finally` block). Runs the same
 * `validateVBundle` checks the importer would run, but never touches the
 * workspace.
 *
 * Does NOT throw on validation or decryption failure — those are returned
 * as `{ valid: false, error: ... }`. Only the missing-key precondition
 * for encrypted bundles throws, since that is a programmer error.
 */
export async function verifySnapshot(
  snapshotPath: string,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const { key } = opts;

  // Encrypted bundles must have a key — this is a precondition error,
  // not a validation failure, so we throw rather than return.
  if (isEncryptedSnapshot(snapshotPath) && !key) {
    throw new Error("Encrypted snapshot requires a decryption key");
  }

  let tmpPath: string | null = null;
  try {
    let plaintextPath: string;
    try {
      const materialized = await materializePlaintext(snapshotPath, key);
      tmpPath = materialized.tmpPath;
      plaintextPath = materialized.path;
    } catch (err) {
      // Decryption / I/O failure — surface as a soft error so verification
      // callers (e.g. snapshot list health checks) get a uniform shape.
      return {
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let fileData: Uint8Array;
    try {
      fileData = await readFile(plaintextPath);
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const validation = validateVBundle(fileData);
    if (!validation.is_valid || !validation.manifest) {
      const summary = validation.errors
        .map((e) => `${e.code}: ${e.message}`)
        .join("; ");
      return { valid: false, error: summary };
    }

    return { valid: true, manifest: validation.manifest };
  } finally {
    await safeUnlink(tmpPath);
  }
}
