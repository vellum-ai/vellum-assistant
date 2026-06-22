import { join } from "node:path";

import { getDataDir } from "./platform.js";

/**
 * Path to the dedicated SQLite file that houses heavy append-only tables
 * (LLM request logs, and other log/event tables over time). It lives in the
 * same `data/db` directory as the main DB and is opened on its own connection
 * (see `getLogsDb()` in `memory/db-connection.ts`). Splitting these tables into
 * their own file keeps the main DB — and its WAL — small and lets the two files
 * VACUUM/checkpoint independently.
 *
 * Kept in its own leaf module rather than alongside `getDbPath()` in
 * `platform.ts`: `platform.ts` is imported very early and widely, and adding an
 * export to it that low-level consumers (e.g. `db-connection.ts`) pull in
 * across the daemon's large, cyclic import graph trips a Bun link-order bug
 * ("Export named 'getLogsDbPath' not found"). Isolating it here keeps
 * `platform.ts`'s module shape stable.
 */
export function getLogsDbPath(): string {
  return join(getDataDir(), "db", "assistant-logs.db");
}
