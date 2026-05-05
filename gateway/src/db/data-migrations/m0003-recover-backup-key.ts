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
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getLogger } from "../../logger.js";
import { getGatewaySecurityDir, getLegacyRootDir, getWorkspaceDir } from "../../paths.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0003-recover-backup-key");

const BACKUP_KEY_FILENAME = "backup.key";

export function up(): MigrationResult {
  const targetPath = join(getGatewaySecurityDir(), BACKUP_KEY_FILENAME);

  if (existsSync(targetPath)) {
    log.info({ targetPath }, "Backup key already exists at target — nothing to do");
    return "done";
  }

  // Check both possible source locations
  const workspacePath = join(getWorkspaceDir(), ".backup.key");
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
      return "done";
    } catch (err) {
      log.error({ err, source }, "Failed to copy backup key — will retry");
      return "skip";
    }
  }

  log.info("No existing backup key found at either legacy location — ensureBackupKey will generate one");
  return "done";
}

export function down(): MigrationResult {
  return "done";
}
