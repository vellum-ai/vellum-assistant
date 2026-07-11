import {
  getMemoryDb as getMemoryDbConnection,
  getMemorySqlite as getMemorySqliteConnection,
} from "../../../persistence/db-connection.js";
import { getLogger } from "./logging.js";

const log = getLogger("memory-db");

/**
 * The memory plugin's gateway to the dedicated memory database
 * (`assistant-memory.db`), where its relocated tables live
 * (`memory_v2_injection_events`, with more to follow). This is the single
 * place plugin code resolves the memory connection; plugin modules import
 * these accessors from here rather than reaching into
 * `persistence/db-connection` directly.
 *
 * The connection's open/pragma/caching lifecycle stays in persistence — these
 * are thin wrappers over the host accessors, so plugin and host code share the
 * one cached `"memory"` connection. (Host/runtime code keeps calling the
 * persistence accessors directly; the plugin-boundary guard forbids host code
 * from importing this plugin module.)
 */

/**
 * Get-or-open the memory connection's Drizzle instance, or `null` when the
 * file cannot be opened (logged by the persistence layer; the daemon stays up).
 */
export function getMemoryDb() {
  return getMemoryDbConnection();
}

/** Underlying bun:sqlite Database for the memory connection, or `null`. */
export function getMemorySqlite() {
  return getMemorySqliteConnection();
}

/**
 * Fail-soft memory-connection accessor for reads/writes that must degrade
 * rather than throw: returns `null` when the file cannot be opened, logging a
 * warn tagged with the calling context. Callers degrade — the memory database
 * holds scoring signal and derived state, and losing it must never break
 * routing or a turn.
 */
export function memorySqliteOrNull(context: string) {
  const sqlite = getMemorySqliteConnection();
  if (!sqlite) {
    log.warn(
      { context },
      "memory database unavailable; memory-db reads/writes degraded",
    );
  }
  return sqlite;
}
