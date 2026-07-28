import {
  type DrizzleDb,
  getMemoryDb,
  getMemorySqlite,
} from "../../../persistence/db-connection.js";
import { getLogger } from "./logging.js";

const log = getLogger("memory-db");

/**
 * The plugin's accessor for the dedicated memory database
 * (`assistant-memory.db`), where the memory plugin's relocated tables live.
 * The `move-*-to-memory-db` migrations in `persistence/migrations/` define
 * the current set of relocated tables.
 *
 * Fail-soft: returns `null` when the file cannot be opened, logging a warn
 * tagged with the calling context. Callers degrade rather than throw — the
 * memory database holds scoring signal and derived state, and losing it must
 * never break routing or a turn. This is the single place plugin code
 * resolves the memory connection; new plugin modules should import it from
 * here rather than reaching into `persistence/db-connection` directly.
 */
export function memorySqliteOrNull(context: string) {
  const sqlite = getMemorySqlite();
  if (!sqlite) {
    log.warn(
      { context },
      "memory database unavailable; memory-db reads/writes degraded",
    );
  }
  return sqlite;
}

/**
 * The drizzle counterpart of {@link memorySqliteOrNull}: returns the memory
 * connection's `DrizzleDb`, or `null` (with the same degraded-mode warning)
 * when the connection is unavailable. Availability is gated on the underlying
 * sqlite client so callers degrade in exactly the cases the raw path did — a
 * stored connection whose `$client` is absent reports null here even though
 * `getMemoryDb()` still returns the shell.
 */
export function memoryDbOrNull(context: string): DrizzleDb | null {
  if (!memorySqliteOrNull(context)) return null;
  return getMemoryDb();
}
