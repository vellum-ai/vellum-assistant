/**
 * Test-only utilities for resetting the assistant DB singleton.
 *
 * Replaces the removed `resetDb` export from `db-connection.ts`. Lives
 * here (not in the source module) because production modules should not
 * expose test backdoors.
 *
 * No source-module imports
 * ------------------------
 * This file has ZERO imports from `src/`. It accesses the DB singleton's
 * state via the shared `globalThis.vellumAssistant.dbSingleton` slot
 * that `src/memory/db-singleton.ts` also reads/writes. The slot shape
 * is duplicated here on purpose: keeping this file off the production
 * import graph is what protects the test preload from a broken
 * `node_modules` symlink (DB ghost #3). The two declarations MUST stay
 * in sync — if you change one, change the other.
 *
 * Production code that needs to close + reopen the DB (post-migration,
 * post-restore, post-vbundle-import, on shutdown) should use `resetDb()`
 * from `src/memory/db-connection.ts` instead.
 */

// Mirrors `src/memory/db-singleton.ts`. Duplicated by design — see the
// "No source-module imports" section above.
type DbSlot = {
  db: unknown;
  closer: (() => void) | null;
};

type VellumAssistantNamespace = {
  dbSingleton?: DbSlot;
};

function dbSlot(): DbSlot {
  const g = globalThis as { vellumAssistant?: VellumAssistantNamespace };
  const ns = (g.vellumAssistant ??= {});
  return (ns.dbSingleton ??= { db: null, closer: null });
}

/**
 * Close the active DB connection (if any) and drop the singleton.
 *
 * Used by tests that nuke or replace the DB file mid-run — without this
 * reset, subsequent `getDb()` calls return a handle to the now-gone file.
 * Idempotent: safe to call when no connection has been opened.
 */
export function resetDbForTesting(): void {
  const s = dbSlot();
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
