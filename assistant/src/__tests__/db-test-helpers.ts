/**
 * Test-only utilities for resetting the assistant DB singletons.
 *
 * Replaces the removed `resetDb` export from `db-connection.ts`. Lives
 * here (not in the source module) because production modules should not
 * expose test backdoors.
 *
 * No source-module imports
 * ------------------------
 * This file has ZERO imports from `src/`. It accesses the DB singletons'
 * state via the shared `globalThis.vellumAssistant.dbSingletons` slots
 * that `src/memory/db-singleton.ts` also reads/writes. The slot shape
 * is duplicated here on purpose: keeping this file off the production
 * import graph is what protects the test preload from a broken
 * `node_modules` symlink (DB ghost #3). The two declarations MUST stay
 * in sync — if you change one, change the other.
 *
 * Production code that needs to close + reopen the DBs (post-migration,
 * post-restore, post-vbundle-import, on shutdown) should use `resetDb()`
 * from `src/memory/db-connection.ts` instead.
 */

// Mirrors `src/memory/db-singleton.ts`. Duplicated by design — see the
// "No source-module imports" section above.
type DbSlotKey = "main" | "logs" | "memory";

type DbSlot = {
  db: unknown;
  closer: (() => void) | null;
};

type DbSlots = Record<DbSlotKey, DbSlot>;

type VellumAssistantNamespace = {
  dbSingletons?: DbSlots;
};

function emptySlot(): DbSlot {
  return { db: null, closer: null };
}

function dbSlots(): DbSlots {
  const g = globalThis as { vellumAssistant?: VellumAssistantNamespace };
  const ns = (g.vellumAssistant ??= {});
  return (ns.dbSingletons ??= {
    main: emptySlot(),
    logs: emptySlot(),
    memory: emptySlot(),
  });
}

/**
 * Close every active DB connection (main, logs, memory) and drop the
 * singletons.
 *
 * Used by tests that nuke or replace a DB file mid-run — without this
 * reset, subsequent `getDb()`/`getLogsDb()`/`getMemoryDb()` calls return a
 * handle to the now-gone file. Idempotent: safe to call when no connection
 * has been opened.
 */
export function resetDbForTesting(): void {
  const slots = dbSlots();
  for (const key of ["main", "logs", "memory"] as const) {
    const s = slots[key];
    if (s.closer) {
      try {
        s.closer();
      } catch {
        /* best-effort close */
      }
    }
    s.db = null;
    s.closer = null;
  }
}
