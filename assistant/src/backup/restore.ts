/**
 * High-level helpers for restoring and verifying backup snapshots.
 *
 * Only plaintext `.vbundle` files are supported directly. Encrypted
 * `.vbundle.enc` files must be restored through the gateway, which owns the
 * backup encryption key (ATL-397).
 *
 * Restore is a thin wrapper around `commitImport` in
 * `runtime/migrations/vbundle-importer.ts`, which handles bundle validation,
 * workspace clearing, per-file backup-before-overwrite, and writing files.
 *
 * `restoreFromSnapshot` closes the live SQLite singleton via `resetDb()`
 * before the commit step so the daemon's DB handle is released before
 * `assistant.db` is overwritten on disk.
 *
 * Credentials are intentionally excluded from backups — they live in the OS
 * keychain / CES and are not restored by this path.
 */

import { readFile } from "node:fs/promises";

import { resetDb } from "../memory/db-connection.js";
import type { PathResolver } from "../runtime/migrations/vbundle-import-analyzer.js";
import { commitImport } from "../runtime/migrations/vbundle-importer.js";
import type { ManifestType } from "../runtime/migrations/vbundle-validator.js";
import { validateVBundle } from "../runtime/migrations/vbundle-validator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

type CommitImpl = typeof commitImport;

interface RestoreOptions {
  pathResolver: PathResolver;
  workspaceDir?: string;
  commitImpl?: CommitImpl;
  resetDbImpl?: () => void;
}

export interface RestoreResult {
  manifest: ManifestType;
  restoredFiles: number;
}

export interface VerifyResult {
  valid: boolean;
  manifest?: ManifestType;
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isEncryptedSnapshot(snapshotPath: string): boolean {
  return snapshotPath.endsWith(".vbundle.enc");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Restore a plaintext backup snapshot into the workspace.
 *
 * Encrypted `.vbundle.enc` snapshots are rejected — use the gateway's
 * restore endpoint for those.
 */
export async function restoreFromSnapshot(
  snapshotPath: string,
  opts: RestoreOptions,
): Promise<RestoreResult> {
  if (isEncryptedSnapshot(snapshotPath)) {
    throw new Error(
      "Encrypted snapshot restore must go through the gateway, which owns the backup key. " +
        "Use the gateway's restore endpoint instead.",
    );
  }

  const {
    pathResolver,
    workspaceDir,
    commitImpl = commitImport,
    resetDbImpl = resetDb,
  } = opts;

  const fileData = await readFile(snapshotPath);

  const validation = validateVBundle(fileData);
  if (!validation.is_valid || !validation.manifest || !validation.entries) {
    const summary = validation.errors
      .map((e) => `${e.code}: ${e.message}`)
      .join("; ");
    throw new Error(`Snapshot failed validation: ${summary}`);
  }

  resetDbImpl();

  const commitResult = commitImpl({
    archiveData: fileData,
    pathResolver,
    preValidatedManifest: validation.manifest,
    preValidatedEntries: validation.entries,
    workspaceDir,
  });

  if (!commitResult.ok) {
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
}

/**
 * Verify a backup snapshot without restoring it.
 *
 * Only plaintext `.vbundle` files are supported. Encrypted snapshots must be
 * verified through the gateway.
 */
export async function verifySnapshot(
  snapshotPath: string,
): Promise<VerifyResult> {
  if (isEncryptedSnapshot(snapshotPath)) {
    return {
      valid: false,
      error:
        "Encrypted snapshot verification must go through the gateway, which owns the backup key.",
    };
  }

  let fileData: Uint8Array;
  try {
    fileData = await readFile(snapshotPath);
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
}
