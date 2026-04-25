/**
 * One-time migration: copy guardian-init lock files for the original
 * first-local assistant whose lock lived at `~/.vellum/`.
 *
 * Guardian-init shipped 2026-03-15; the refactor that moved the lock into
 * `.vellum/protected/` shipped 2026-04-14, one day after multi-instance.
 * The only realistic case with a stranded legacy lock is the pre-multi-
 * instance first-local whose instanceDir is `$HOME`. We restrict to
 * exactly that case so the migration can never pick up an unrelated
 * `guardian-init.lock` from elsewhere on the filesystem.
 */

import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { getLogger } from "../../logger.js";
import { getGatewaySecurityDir, getLegacyRootDir } from "../../paths.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0001-guardian-init-lock");

const FILES = ["guardian-init.lock", "guardian-init-consumed.json"] as const;

export function up(): MigrationResult {
  const legacyDir = getLegacyRootDir();
  const newDir = getGatewaySecurityDir();

  // Only the original first-local assistant (instanceDir === $HOME) can
  // have a stranded legacy lock — its new dir resolves to `~/.vellum/protected`.
  // Any other shape means this isn't that instance; skip. Normalize both
  // sides so a user-supplied GATEWAY_SECURITY_DIR with trailing slashes
  // still matches.
  if (resolve(legacyDir, "protected") !== resolve(newDir)) {
    log.info({ newDir }, "Not the first-local layout — nothing to migrate");
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
