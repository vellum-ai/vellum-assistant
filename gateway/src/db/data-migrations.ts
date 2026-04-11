/**
 * One-time data migrations that run after schema setup on gateway startup.
 *
 * Each migration is guarded by the `one_time_migrations` table: once a
 * migration key is recorded, it never runs again. Migrations execute
 * sequentially in the order they appear in the `MIGRATIONS` array.
 */

import type { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getGatewaySecurityDir } from "../config.js";
import { getWorkspaceDir } from "../credential-reader.js";
import { getLogger } from "../logger.js";

const log = getLogger("data-migrations");

type Migration = {
  key: string;
  run: () => void;
};

// ---------------------------------------------------------------------------
// Migration: move proxy-ca directory to gateway-security
// ---------------------------------------------------------------------------

/**
 * The assistant's outbound proxy generates a self-signed CA cert + key in
 * `{workspaceDir}/data/proxy-ca/`. This is security-sensitive material
 * (private key) that should live on the gateway-security volume rather
 * than the shared workspace volume.
 *
 * This migration copies the directory to `{gatewaySecurityDir}/proxy-ca/`
 * and removes the old copy. Uses copy-then-delete (not rename) because the
 * source and destination are on different Docker volumes.
 */
function migrateProxyCa(): void {
  const srcDir = join(getWorkspaceDir(), "data", "proxy-ca");
  const destDir = join(getGatewaySecurityDir(), "proxy-ca");

  if (existsSync(destDir)) {
    log.debug("proxy-ca already exists in gateway-security dir — skipping");
    return;
  }

  if (!existsSync(srcDir)) {
    log.debug("No legacy proxy-ca directory found — skipping");
    return;
  }

  // Verify the source has at least one file before copying
  const entries = readdirSync(srcDir);
  if (entries.length === 0) {
    log.debug("Legacy proxy-ca directory is empty — skipping");
    return;
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
}

// ---------------------------------------------------------------------------
// Migration registry — append new migrations at the end
// ---------------------------------------------------------------------------

const MIGRATIONS: Migration[] = [
  { key: "migrate_proxy_ca_to_gateway_security", run: migrateProxyCa },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Execute any one-time data migrations that haven't run yet.
 * Must be called after schema migrations so the `one_time_migrations`
 * table exists.
 */
export function runDataMigrations(db: Database): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO one_time_migrations (key, ran_at) VALUES (?, ?)",
  );

  for (const migration of MIGRATIONS) {
    const row = db
      .prepare("SELECT 1 FROM one_time_migrations WHERE key = ?")
      .get(migration.key) as Record<string, unknown> | null;

    if (row) continue;

    log.info({ key: migration.key }, "Running one-time data migration");
    try {
      migration.run();
      insert.run(migration.key, Date.now());
      log.info({ key: migration.key }, "Data migration completed");
    } catch (err) {
      log.error(
        { err, key: migration.key },
        "Data migration failed — will retry on next startup",
      );
      // Don't insert the key so it retries next time
    }
  }
}
