/**
 * Holds optional path overrides for the encrypted credential store.
 *
 * Lives in its own module (rather than alongside the crypto code in
 * `encrypted-store.ts`) so test helpers can install/clear overrides
 * without importing `encrypted-store.ts` — which transitively pulls
 * `util/logger.js` (pino). Stdlib-only by design: this file must remain
 * safe to import from the test preload's load-time chain, where a broken
 * `node_modules` symlink has historically tripped the env override
 * (see DB ghost #3, /workspace/journal/2026-05-25-db-ghost-3-recovery.md).
 *
 * Note: the new test preload places `VELLUM_WORKSPACE_DIR` at
 * `<tmpRoot>/workspace`, so `getProtectedDir()` resolves to
 * `<tmpRoot>/protected` naturally — most tests no longer need an explicit
 * override. The setters here exist for the small set of tests that
 * exercise specific path scenarios (env-var fallbacks, migration, etc.).
 *
 * Consumers:
 *   - `encrypted-store.ts` (reads the override when computing paths)
 *   - `__tests__/encrypted-store-test-helpers.ts` (writes for tests)
 */

let storePathOverride: string | null = null;
let storeKeyPathOverride: string | null = null;

export function getStorePathOverride(): string | null {
  return storePathOverride;
}

/** Pass `null` to reset to the default (`<protectedDir>/keys.enc`). */
export function setStorePathOverride(path: string | null): void {
  storePathOverride = path;
}

export function getStoreKeyPathOverride(): string | null {
  return storeKeyPathOverride;
}

/** Pass `null` to reset to the default (`<dirname(storePath)>/store.key`). */
export function setStoreKeyPathOverride(path: string | null): void {
  storeKeyPathOverride = path;
}
