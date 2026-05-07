/**
 * One-time migration: recover backup.key into GATEWAY_SECURITY_DIR.
 *
 * The backup key may exist at either of two legacy locations depending on
 * which version of the assistant created it:
 *
 *   1. ~/.vellum/workspace/.backup.key  — migration 061 moved it here
 *   2. ~/.vellum/protected/backup.key   — original location (pre-061)
 *
 * This migration copies the key from whichever location has it into the
 * canonical gateway security directory (GATEWAY_SECURITY_DIR), which in
 * local mode resolves to ~/.vellum/protected/ and in Docker mode to a
 * dedicated volume. If the key already exists at the target, we leave it
 * alone — the gateway's ensureBackupKey handles first-time generation.
 *
 * Defense in depth (ATL-444): regardless of which source we copy from, the
 * workspace copy at ~/.vellum/workspace/.backup.key MUST be removed before
 * we return. The workspace is the assistant's sandbox surface — `bash` and
 * other tools read files from it without `path-policy.ts` mediation, so a
 * leftover `.backup.key` is exposed to prompt-injection-driven exfiltration.
 * Workspace migration 072 also handles this on the assistant side; we
 * mirror it here so the gateway is self-defending even if the workspace
 * migration was skipped or rolled back.
 */

import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getLogger } from "../../logger.js";
import { getGatewaySecurityDir, getLegacyRootDir, getWorkspaceDir } from "../../paths.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0003-recover-backup-key");

const BACKUP_KEY_FILENAME = "backup.key";
const WORKSPACE_BACKUP_KEY_FILENAME = ".backup.key";

/**
 * Remove the workspace copy of the backup key. The workspace is a
 * prompt-injectable sandbox surface and must never hold the encryption key.
 *
 * Skipped only when the workspace path resolves to the same file as the
 * target (defensive — should not happen with sane env configs, but unlinking
 * the only copy of the key would be unrecoverable).
 */
function removeWorkspaceCopy(workspacePath: string, targetPath: string): void {
  if (resolve(workspacePath) === resolve(targetPath)) return;
  if (!existsSync(workspacePath)) return;
  try {
    unlinkSync(workspacePath);
    log.info({ workspacePath }, "Removed stale workspace backup key copy");
  } catch (err) {
    log.warn(
      { err, workspacePath },
      "Failed to remove stale workspace backup key (best-effort)",
    );
  }
}

export function up(): MigrationResult {
  const targetPath = join(getGatewaySecurityDir(), BACKUP_KEY_FILENAME);
  const workspacePath = join(getWorkspaceDir(), WORKSPACE_BACKUP_KEY_FILENAME);

  if (existsSync(targetPath)) {
    log.info({ targetPath }, "Backup key already exists at target — nothing to do");
    removeWorkspaceCopy(workspacePath, targetPath);
    return "done";
  }

  const legacyProtectedPath = join(getLegacyRootDir(), "protected", BACKUP_KEY_FILENAME);

  // Prefer the workspace copy (migration 061 moved it there most recently)
  const sourceCandidates = [workspacePath, legacyProtectedPath];

  for (const source of sourceCandidates) {
    // Skip if source is the same file as target (local mode where
    // GATEWAY_SECURITY_DIR == ~/.vellum/protected/)
    if (resolve(source) === resolve(targetPath)) {
      log.info({ source }, "Source is the same as target — skipping");
      continue;
    }

    if (!existsSync(source)) continue;

    try {
      mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
      copyFileSync(source, targetPath);
      log.info({ from: source, to: targetPath }, "Recovered backup key");
      removeWorkspaceCopy(workspacePath, targetPath);
      return "done";
    } catch (err) {
      log.error({ err, source }, "Failed to copy backup key — will retry");
      return "skip";
    }
  }

  log.info("No existing backup key found at either legacy location — ensureBackupKey will generate one");
  // No source found → workspace path didn't exist either, but call cleanup
  // for symmetry; it's a no-op when the file is absent.
  removeWorkspaceCopy(workspacePath, targetPath);
  return "done";
}

export function down(): MigrationResult {
  return "done";
}
