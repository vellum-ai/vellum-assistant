/**
 * Holds the assistant DB connection singletons and their close callbacks.
 *
 * Four connections live here under the same `globalThis.vellumAssistant`
 * namespace, keyed by slot: the `main` daemon connection, the `logs`
 * connection (`assistant-logs.db`), the `memory` connection
 * (`assistant-memory.db`), and the `telemetry` connection
 * (`assistant-telemetry.db`). Each is opened lazily by `db-connection.ts`.
 *
 * Lives in its own module (rather than alongside the resolvers in
 * `db-connection.ts`) so test code can reset the singletons without
 * importing `db-connection.ts` — which transitively pulls
 * `drizzle-orm/bun-sqlite`. Stdlib-only by design: this file must remain
 * safe to import from the test preload's load-time chain, where a broken
 * `node_modules` symlink has historically tripped the env override
 * (see DB ghost #3, /workspace/journal/2026-05-25-db-ghost-3-recovery.md).
 *
 * State is held on `globalThis.vellumAssistant.dbSingletons` so test
 * helpers in `__tests__/` can read/write it WITHOUT importing this
 * module — they declare the same slot shape locally and access the
 * globalThis namespace directly. See
 * `__tests__/db-test-helpers.ts` for the test-side mirror; the slot
 * shape MUST stay in sync between the two.
 *
 * The stored value is typed as `unknown` so this file never has to import
 * Drizzle types. Callers in `db-connection.ts` narrow via the type
 * parameter on `getStoredDb<DrizzleDb>()`.
 *
 * Consumers:
 *   - `db-connection.ts` (opens/owns the connections)
 *   - production callers that need to close the active connections
 *     (migration routes, vbundle import, backup/restore, daemon shutdown)
 *   - `__tests__/db-test-helpers.ts` (per-test reset, via globalThis)
 */

/** Which connection a slot holds. */
export type DbSlotKey =
  | "main"
  | "main-readonly"
  | "logs"
  | "memory"
  | "telemetry";

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

function slots(): DbSlots {
  const g = globalThis as { vellumAssistant?: VellumAssistantNamespace };
  const ns = (g.vellumAssistant ??= {});
  return (ns.dbSingletons ??= {
    main: emptySlot(),
    "main-readonly": emptySlot(),
    logs: emptySlot(),
    memory: emptySlot(),
    telemetry: emptySlot(),
  });
}

function slot(key: DbSlotKey): DbSlot {
  return slots()[key];
}

/** Read the current singleton for `key`, narrowed to `T`. `null` means not yet opened. */
export function getStoredDb<T>(key: DbSlotKey): T | null {
  return slot(key).db as T | null;
}

/**
 * Store a freshly-opened connection and the closer to run on
 * `clearStoredDb(key)`. The closer must be self-contained — it is invoked
 * inside a try/catch, so partial failures are swallowed (best-effort
 * close on shutdown / restore paths).
 */
export function setStoredDb<T>(
  key: DbSlotKey,
  newDb: T,
  close: () => void,
): void {
  const s = slot(key);
  s.db = newDb;
  s.closer = close;
}

/**
 * Close the active connection for `key` (if any) via the stored closer,
 * then drop both. Idempotent: safe to call when no connection is stored.
 */
export function clearStoredDb(key: DbSlotKey): void {
  const s = slot(key);
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
