/**
 * Shared SQLite access for the monitor's recovery steps.
 *
 * Recovery runs OUT OF PROCESS from the daemon, so it never uses the daemon's
 * `getDb()` singleton (which assumes the daemon process and its migration
 * lifecycle). Each step opens its own short-lived read/write handle on the
 * daemon's database file, owns it for one run, and closes it before returning.
 */

import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import { getDbPath } from "../../util/platform.js";

const log = getLogger("recovery-db");

/** Max time a recovery write waits on the daemon's writer lock before erroring. */
export const RECOVERY_BUSY_TIMEOUT_MS = 5_000;

/**
 * Open a read/write handle on the daemon's SQLite database. Returns null when
 * the database file does not exist yet (the daemon has not booted) — never
 * creating it. The caller owns the handle for the lifetime of one run and must
 * close it before returning.
 */
export function openRecoveryDb(): Database | null {
  if (!existsSync(getDbPath())) {
    return null; // daemon has not created the database yet
  }
  try {
    const db = new Database(getDbPath(), { readwrite: true, create: false });
    db.exec(`PRAGMA busy_timeout=${RECOVERY_BUSY_TIMEOUT_MS}`);
    return db;
  } catch (err) {
    log.debug({ err }, "recovery: could not open database");
    return null;
  }
}
