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

/** The raw memory connection {@link memorySqliteOrNull} resolves, for modules
 *  that hand the handle to a helper. */
export type MemorySqlite = NonNullable<ReturnType<typeof memorySqliteOrNull>>;

/**
 * The drizzle counterpart of {@link memorySqliteOrNull}: returns the memory
 * connection's `DrizzleDb`, or `null` (with the same degraded-mode warning)
 * when the connection is unavailable. Availability is gated on the underlying
 * sqlite client so callers degrade in exactly the cases the raw path did — a
 * stored connection whose `$client` is absent reports null here even though
 * `getMemoryDb()` still returns the shell.
 */
export function memoryDbOrNull(context: string): DrizzleDb | null {
  if (!memorySqliteOrNull(context)) {
    return null;
  }
  return getMemoryDb();
}

/**
 * The raw memory connection with `ensure` applied to it, or `null` (with the
 * degraded-mode warning) when the connection is unavailable: what a store
 * resolves before every statement.
 */
export function ensuredMemorySqlite(
  context: string,
  ensure: (memoryRaw: MemorySqlite) => void,
): MemorySqlite | null {
  const raw = memorySqliteOrNull(context);
  if (raw) {
    ensure(raw);
  }
  return raw;
}

/**
 * A fail-soft reader over the memory connection for one store. `resolve`
 * returns the store's handle with its schema ensured, or `null` when the
 * connection is unavailable ({@link ensuredMemorySqlite}, or a store's own
 * resolver); the reader runs `read` on it and returns `fallback` when there
 * is no handle or the read throws (a missing table on an install whose
 * migration is still deferred, an I/O error), reporting a throw to
 * `onFailure` with the read's `context`. A read failure never takes
 * memory-v3 down with it: an empty dedup set re-injects a section at worst,
 * and an inspector read shows no diagnostic rather than failing its route.
 */
export function memoryReader<Handle>(
  resolve: (context: string) => Handle | null,
  onFailure: (err: unknown, context: string) => void,
): <T>(context: string, fallback: T, read: (handle: Handle) => T) => T {
  return (context, fallback, read) => {
    try {
      const handle = resolve(context);
      return handle === null ? fallback : read(handle);
    } catch (err) {
      onFailure(err, context);
      return fallback;
    }
  };
}

/**
 * Wrap a schema ensure so it runs once per connection in this process:
 * idempotent DDL, fail-open. A failed ensure warns once, with
 * `degradedMessage`, and leaves the statement that follows to fail soft like
 * any other; the connection is tried again on its next use, and a reopened
 * connection is ensured again.
 */
export function ensureOncePerConnection(
  ensure: (memoryRaw: MemorySqlite) => void,
  degradedMessage: string,
): (memoryRaw: MemorySqlite) => void {
  const ensured = new WeakSet<MemorySqlite>();
  let warned = false;
  return (memoryRaw) => {
    if (ensured.has(memoryRaw)) {
      return;
    }
    try {
      ensure(memoryRaw);
      ensured.add(memoryRaw);
    } catch (err) {
      if (!warned) {
        warned = true;
        log.warn({ err }, degradedMessage);
      }
    }
  };
}
