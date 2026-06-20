import { join } from "node:path";

import { getDataDir } from "./platform.js";

/**
 * Path to the secondary SQLite file that houses the high-churn memory
 * subsystem tables (starting with the `memory_jobs` work queue). It lives in
 * the same `data/db` directory as the main DB and is ATTACHed to the daemon's
 * connection as the `memory` schema (see `memory/db-connection.ts`). Splitting
 * these tables into their own file keeps the main DB — and its WAL — small and
 * lets the two files VACUUM/checkpoint independently, so a runaway queue can no
 * longer bloat the main database.
 *
 * Kept in its own leaf module rather than alongside `getDbPath()` in
 * `platform.ts`: `platform.ts` is imported very early and widely, and adding an
 * export to it that low-level consumers (e.g. `db-connection.ts`) pull in
 * across the daemon's large, cyclic import graph trips a Bun link-order bug
 * ("Export named 'getMemoryDbPath' not found"). Isolating it here keeps
 * `platform.ts`'s module shape stable — same reasoning as `logs-db-path.ts`.
 */
export function getMemoryDbPath(): string {
  return join(getDataDir(), "db", "assistant-memory.db");
}
