/**
 * Test-only utilities for resetting the assistant DB singletons.
 *
 * Replaces the removed `resetDb` export from `db-connection.ts`. Lives
 * here (not in the source module) because production modules should not
 * expose test backdoors.
 *
 * No source-module imports
 * ------------------------
 * This file has ZERO runtime imports from `src/`. It accesses the DB
 * singletons' state via the shared `globalThis.vellumAssistant.dbSingletons`
 * slots that `src/persistence/db-singleton.ts` also reads/writes, typed by the
 * shared ambient `VellumDbSlots` (declared in
 * `src/vellum-assistant-namespace.d.ts`). That ambient type is pure
 * compile-time information — referencing it adds nothing to this file's runtime
 * import graph — so keeping the helper off the production import graph (what
 * protects the test preload from a broken `node_modules` symlink, DB ghost #3)
 * still holds.
 *
 * Production code that needs to close + reopen the DBs (post-migration,
 * post-restore, post-vbundle-import, on shutdown) should use `resetDb()`
 * from `src/persistence/db-connection.ts` instead.
 */

import { resetGatewayAclStore } from "./helpers/gateway-acl-store.js";

function emptySlot(): VellumDbSlot {
  return { db: null, closer: null };
}

function dbSlots(): VellumDbSlots {
  const ns = (globalThis.vellumAssistant ??= {});
  return (ns.dbSingletons ??= {
    main: emptySlot(),
    "main-readonly": emptySlot(),
    logs: emptySlot(),
    memory: emptySlot(),
    telemetry: emptySlot(),
  });
}

/**
 * Close every active DB connection (main, main-readonly, logs, memory, telemetry) and drop
 * the singletons.
 *
 * Used by tests that nuke or replace a DB file mid-run — without this
 * reset, subsequent `getDb()`/`getLogsDb()`/`getMemoryDb()` calls return a
 * handle to the now-gone file. Idempotent: safe to call when no connection
 * has been opened.
 *
 * Also clears the in-process gateway-ACL test stand-in (a module-level Map),
 * so tests that seed guardian/contact ACL rows get per-test isolation from the
 * same reset that drops the DB singletons.
 */
export function resetDbForTesting(): void {
  resetGatewayAclStore();
  const slots = dbSlots();
  for (const key of [
    "main",
    "main-readonly",
    "logs",
    "memory",
    "telemetry",
  ] as const) {
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
