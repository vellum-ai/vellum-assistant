/**
 * Holds the assistant DB connection singleton and its close callback.
 *
 * Lives in its own module (rather than alongside the resolver in
 * `db-connection.ts`) so test helpers can reset the singleton without
 * importing `db-connection.ts` — which transitively pulls
 * `drizzle-orm/bun-sqlite`. Stdlib-only by design: this file must remain
 * safe to import from the test preload's load-time chain, where a broken
 * `node_modules` symlink has historically tripped the env override
 * (see DB ghost #3, /workspace/journal/2026-05-25-db-ghost-3-recovery.md).
 *
 * The stored value is typed as `unknown` so this file never has to import
 * Drizzle types. Callers in `db-connection.ts` narrow via the type
 * parameter on `getStoredDb<DrizzleDb>()`.
 *
 * Consumers:
 *   - `db-connection.ts` (opens/owns the connection)
 *   - production callers that need to close the active connection
 *     (migration routes, vbundle import, backup/restore, daemon shutdown)
 *   - `__tests__/db-test-helpers.ts` (per-test reset)
 */

let db: unknown = null;
let closer: (() => void) | null = null;

/** Read the current singleton, narrowed to `T`. `null` means not yet opened. */
export function getStoredDb<T>(): T | null {
  return db as T | null;
}

/**
 * Store a freshly-opened connection and the closer to run on
 * `clearStoredDb()`. The closer must be self-contained — it is invoked
 * inside a try/catch, so partial failures are swallowed (best-effort
 * close on shutdown / restore paths).
 */
export function setStoredDb<T>(newDb: T, close: () => void): void {
  db = newDb;
  closer = close;
}

/**
 * Close the active connection (if any) via the stored closer, then drop
 * both. Idempotent: safe to call when no connection is stored.
 */
export function clearStoredDb(): void {
  if (closer) {
    try {
      closer();
    } catch {
      /* best-effort close */
    }
  }
  db = null;
  closer = null;
}
