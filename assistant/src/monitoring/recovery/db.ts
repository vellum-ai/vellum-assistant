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
import { readDaemonBootTime } from "../daemon-boot-time.js";

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

/**
 * Run one recovery step against a boot-fenced database handle.
 *
 * Every step reconciles rows a dead process left behind, so every step needs
 * the same two guards first: a daemon boot time to fence against (without it
 * a live daemon's in-flight row is indistinguishable from a dead process's
 * orphan) and an openable database. `run` is invoked only when both hold, and
 * the handle is closed however it returns.
 *
 * Steps keep their own logger and their own result logging: this owns the
 * preconditions and the handle's lifetime, not what a step does or says.
 * A throw propagates to the orchestrator, which treats it as "schema not
 * ready yet" and retries on the next monitor run.
 */
export function withBootFencedRecoveryDb(
  step: string,
  run: (db: Database, bootTime: number) => void,
): void {
  const bootTime = readDaemonBootTime();
  if (bootTime == null) {
    log.warn({ step }, "Skipping recovery step: daemon boot time unavailable");
    return;
  }
  const db = openRecoveryDb();
  if (db == null) {
    return;
  }
  try {
    run(db, bootTime);
  } finally {
    db.close();
  }
}
