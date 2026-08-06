/**
 * Test-only utilities for overriding the encrypted credential store paths.
 *
 * Replaces the removed `_setStorePath` and `_setStoreKeyPath` exports
 * from `encrypted-store.ts`. Lives here (not in the source module)
 * because production modules should not expose test backdoors.
 *
 * No source-module imports
 * ------------------------
 * This file has ZERO runtime imports from `src/`. It accesses the store-path
 * override state via the shared `globalThis.vellumAssistant.storePathOverride`
 * slot that `src/security/store-path-override.ts` also reads/writes, typed by
 * the shared ambient `VellumStorePathOverride` (declared in
 * `src/vellum-assistant-namespace.d.ts`). That ambient type is pure
 * compile-time information — referencing it adds nothing to this file's runtime
 * import graph — so keeping the helper off the production import graph (what
 * protects the test preload from a broken `node_modules` symlink, DB ghost #3)
 * still holds.
 *
 * Most tests no longer need these overrides: the test preload places
 * `VELLUM_WORKSPACE_DIR` at `<tmpRoot>/workspace`, so `getProtectedDir()`
 * resolves to `<tmpRoot>/protected` per process. The setters here exist
 * for the small set of tests that exercise specific path scenarios
 * (env-var fallbacks, migration corner cases, etc.).
 */

function pathSlot(): VellumStorePathOverride {
  const ns = (globalThis.vellumAssistant ??= {});
  return (ns.storePathOverride ??= { storePath: null, storeKeyPath: null });
}

/**
 * Override the encrypted store file path. Pass `null` to reset to the
 * default (`<protectedDir>/keys.enc`).
 */
export function setStorePathForTesting(path: string | null): void {
  pathSlot().storePath = path;
}

/**
 * Override the store-key file path. Pass `null` to reset to the default
 * (`<dirname(storePath)>/store.key`).
 */
export function setStoreKeyPathForTesting(path: string | null): void {
  pathSlot().storeKeyPath = path;
}
