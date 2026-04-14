/**
 * One-time migration: copy guardian-init lock files from the legacy path
 * (~/.vellum/) to the new gateway-security directory (~/.vellum/protected/
 * in bare-metal mode, or GATEWAY_SECURITY_DIR in Docker).
 *
 * Before this change, channel-verification-session-proxy.ts resolved the
 * lock directory as `GATEWAY_SECURITY_DIR || getRootDir()`. The refactor
 * to `getGatewaySecurityDir()` changed the bare-metal fallback from
 * `~/.vellum/` to `~/.vellum/protected/`. Without this migration, existing
 * bare-metal instances would lose their bootstrap lock and allow a second
 * guardian init.
 */

import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../logger.js";
import { getGatewaySecurityDir, getRootDir } from "../../paths.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0001-guardian-init-lock");

const FILES = ["guardian-init.lock", "guardian-init-consumed.json"] as const;

export function up(): MigrationResult {
  const legacyDir = getRootDir();
  const newDir = getGatewaySecurityDir();

  // If both resolve to the same directory (e.g. GATEWAY_SECURITY_DIR is set
  // and equals getRootDir()), there is nothing to migrate.
  if (legacyDir === newDir) {
    log.info("Legacy and new directories are identical — nothing to migrate");
    return "done";
  }

  for (const file of FILES) {
    const legacyPath = join(legacyDir, file);
    const newPath = join(newDir, file);

    if (!existsSync(legacyPath)) continue;
    if (existsSync(newPath)) {
      log.info({ file }, "File already exists at new path — skipping");
      continue;
    }

    try {
      copyFileSync(legacyPath, newPath);
      log.info({ file, from: legacyPath, to: newPath }, "Copied lock file");
    } catch (err) {
      log.error({ err, file }, "Failed to copy lock file — will retry");
      return "skip";
    }
  }

  return "done";
}

export function down(): MigrationResult {
  // No-op: we don't remove the copied files on rollback.
  return "done";
}
