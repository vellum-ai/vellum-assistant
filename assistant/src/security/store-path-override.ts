/**
 * Holds optional path overrides for the encrypted credential store.
 *
 * Lives in its own module (rather than alongside the crypto code in
 * `encrypted-store.ts`) so test code can install/clear overrides without
 * importing `encrypted-store.ts` — which transitively pulls
 * `util/logger.js` (pino). Stdlib-only by design: this file must remain
 * safe to import from the test preload's load-time chain, where a broken
 * `node_modules` symlink has historically tripped the env override
 * (see DB ghost #3, /workspace/journal/2026-05-25-db-ghost-3-recovery.md).
 *
 * State is held on `globalThis.vellumAssistant.storePathOverride` so
 * test helpers in `__tests__/` can read/write it WITHOUT importing this
 * module. Both sides reference the shared ambient `VellumStorePathOverride`
 * type (declared in `src/vellum-assistant-namespace.d.ts`), which types the
 * slot without adding a runtime import between them. See
 * `__tests__/encrypted-store-test-helpers.ts` for the test-side writer.
 *
 * Note: the new test preload places `VELLUM_WORKSPACE_DIR` at
 * `<tmpRoot>/workspace`, so `getProtectedDir()` resolves to
 * `<tmpRoot>/protected` naturally — most tests no longer need an explicit
 * override. The setters here exist for the small set of tests that
 * exercise specific path scenarios (env-var fallbacks, migration, etc.).
 *
 * Consumers:
 *   - `encrypted-store.ts` (reads the override when computing paths)
 *   - `__tests__/encrypted-store-test-helpers.ts` (writes for tests, via globalThis)
 */

function slot(): VellumStorePathOverride {
  const ns = (globalThis.vellumAssistant ??= {});
  return (ns.storePathOverride ??= { storePath: null, storeKeyPath: null });
}

export function getStorePathOverride(): string | null {
  return slot().storePath;
}

/** Pass `null` to reset to the default (`<protectedDir>/keys.enc`). */
export function setStorePathOverride(path: string | null): void {
  slot().storePath = path;
}

export function getStoreKeyPathOverride(): string | null {
  return slot().storeKeyPath;
}

/** Pass `null` to reset to the default (`<dirname(storePath)>/store.key`). */
export function setStoreKeyPathOverride(path: string | null): void {
  slot().storeKeyPath = path;
}
