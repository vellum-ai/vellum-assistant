/**
 * Migration 0001: Move proxy-ca directory to gateway-security volume.
 *
 * The assistant's outbound proxy generates a self-signed CA cert + key in
 * `{workspaceDir}/data/proxy-ca/`. This is security-sensitive material
 * (private key) that should live on the gateway-security volume rather
 * than the shared workspace volume.
 *
 * Uses copy-then-delete (not rename) because the source and destination
 * are on different Docker volumes.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getGatewaySecurityDir } from "../../config.js";
import { getWorkspaceDir } from "../../credential-reader.js";
import { getLogger } from "../../logger.js";

const log = getLogger("data-migrations");

export type MigrationResult = "done" | "skip";

export function up(): MigrationResult {
  const srcDir = join(getWorkspaceDir(), "data", "proxy-ca");
  const destDir = join(getGatewaySecurityDir(), "proxy-ca");

  // Only treat as "done" if the destination contains the expected CA files.
  // A bare directory (from a failed partial copy) should not short-circuit.
  const destCert = join(destDir, "ca.pem");
  const destKey = join(destDir, "ca-key.pem");
  if (existsSync(destCert) && existsSync(destKey)) {
    log.debug("proxy-ca already exists in gateway-security dir — skipping");
    return "done";
  }

  if (!existsSync(srcDir)) {
    // Source doesn't exist yet — the assistant may not have generated the
    // CA cert. Return "skip" so the migration retries on next startup.
    log.debug("No legacy proxy-ca directory found — will retry next startup");
    return "skip";
  }

  // Verify the source has at least one file before copying
  const entries = readdirSync(srcDir);
  if (entries.length === 0) {
    log.debug("Legacy proxy-ca directory is empty — will retry next startup");
    return "skip";
  }

  try {
    mkdirSync(destDir, { recursive: true });
    cpSync(srcDir, destDir, { recursive: true });
  } catch (err) {
    // Clean up partial copy so the retry sees no destDir and tries again
    try {
      rmSync(destDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }

  // Remove old directory now that the copy succeeded
  try {
    rmSync(srcDir, { recursive: true, force: true });
  } catch {
    // Non-fatal: the old dir is just wasted space, not a correctness issue
    log.warn("Failed to remove legacy proxy-ca directory after migration");
  }

  log.info(
    { from: srcDir, to: destDir, fileCount: entries.length },
    "Migrated proxy-ca to gateway-security directory",
  );
  return "done";
}

export function down(): MigrationResult {
  const srcDir = join(getGatewaySecurityDir(), "proxy-ca");
  const destDir = join(getWorkspaceDir(), "data", "proxy-ca");

  const srcCert = join(srcDir, "ca.pem");
  const srcKey = join(srcDir, "ca-key.pem");
  if (!existsSync(srcCert) || !existsSync(srcKey)) {
    log.debug("No proxy-ca in gateway-security dir — nothing to roll back");
    return "skip";
  }

  if (
    existsSync(join(destDir, "ca.pem")) &&
    existsSync(join(destDir, "ca-key.pem"))
  ) {
    log.debug("proxy-ca already exists in workspace dir — skipping rollback");
    return "done";
  }

  try {
    mkdirSync(destDir, { recursive: true });
    cpSync(srcDir, destDir, { recursive: true });
  } catch (err) {
    try {
      rmSync(destDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }

  try {
    rmSync(srcDir, { recursive: true, force: true });
  } catch {
    log.warn(
      "Failed to remove gateway-security proxy-ca directory after rollback",
    );
  }

  log.info(
    { from: srcDir, to: destDir },
    "Rolled back proxy-ca to workspace directory",
  );
  return "done";
}
