import { getMemorySqlite } from "../../../persistence/db-connection.js";
import { getLogger } from "./logging.js";

const log = getLogger("memory-db");

/**
 * The plugin's accessor for the dedicated memory database
 * (`assistant-memory.db`), where the memory plugin's relocated tables live
 * (`memory_v2_injection_events`, `memory_v3_selections`,
 * `activation_sessions`, with more to follow).
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
