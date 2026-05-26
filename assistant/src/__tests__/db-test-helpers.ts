/**
 * Test-only utilities for resetting the assistant DB singleton.
 *
 * Replaces the removed `resetDb` export from `db-connection.ts`. Lives
 * here (not in the source module) because production modules should not
 * expose test backdoors, and because importing from this file pulls only
 * the stdlib-only `db-singleton.ts` — never `drizzle-orm/bun-sqlite`.
 *
 * Production code that needs to close + reopen the DB (post-migration,
 * post-restore, post-vbundle-import, on shutdown) should use
 * `closeAssistantDb()` from `db-connection.ts` instead.
 *
 * See `src/memory/db-singleton.ts` for the underlying state contract.
 */

import { clearStoredDb } from "../memory/db-singleton.js";

/**
 * Close the active DB connection (if any) and drop the singleton.
 *
 * Used by tests that nuke or replace the DB file mid-run — without this
 * reset, subsequent `getDb()` calls return a handle to the now-gone file.
 * Idempotent: safe to call when no connection has been opened.
 */
export function resetDbForTesting(): void {
  clearStoredDb();
}
