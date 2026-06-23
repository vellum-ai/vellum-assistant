import { join } from "node:path";

import { getDataDir } from "./platform.js";

/**
 * Path to the dedicated SQLite file that houses telemetry event tables
 * (starting with `watchdog_events`). It lives in the same `data/db` directory
 * as the main DB and is opened on its own connection (see `getTelemetryDb()`
 * in `memory/db-connection.ts`). Splitting telemetry tables into their own
 * file keeps the main DB — and its WAL — small and lets the two files
 * VACUUM/checkpoint independently, so a burst of watchdog events can no longer
 * bloat the main database.
 *
 * Kept in its own leaf module rather than alongside `getDbPath()` in
 * `platform.ts`: `platform.ts` is imported very early and widely, and adding an
 * export to it that low-level consumers (e.g. `db-connection.ts`) pull in
 * across the daemon's large, cyclic import graph trips a Bun link-order bug
 * ("Export named 'getTelemetryDbPath' not found"). Isolating it here keeps
 * `platform.ts`'s module shape stable — same reasoning as `logs-db-path.ts`
 * and `memory-db-path.ts`.
 */
export function getTelemetryDbPath(): string {
  return join(getDataDir(), "db", "assistant-telemetry.db");
}
