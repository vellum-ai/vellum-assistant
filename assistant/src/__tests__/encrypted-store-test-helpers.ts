/**
 * Test-only utilities for overriding the encrypted credential store paths.
 *
 * Replaces the removed `_setStorePath` and `_setStoreKeyPath` exports
 * from `encrypted-store.ts`. Lives here (not in the source module)
 * because production modules should not expose test backdoors.
 *
 * No source-module imports
 * ------------------------
 * This file has ZERO imports from `src/`. It accesses the store-path
 * override state via the shared `globalThis.vellumAssistant.storePathOverride`
 * slot that `src/security/store-path-override.ts` also reads/writes. The
 * slot shape is duplicated here on purpose: keeping this file off the
 * production import graph is what protects the test preload from a
 * broken `node_modules` symlink (DB ghost #3). The two declarations MUST
 * stay in sync — if you change one, change the other.
 *
 * Most tests no longer need these overrides: the test preload places
 * `VELLUM_WORKSPACE_DIR` at `<tmpRoot>/workspace`, so `getProtectedDir()`
 * resolves to `<tmpRoot>/protected` per process. The setters here exist
 * for the small set of tests that exercise specific path scenarios
 * (env-var fallbacks, migration corner cases, etc.).
 */

// Mirrors `src/security/store-path-override.ts`. Duplicated by design — see
// the "No source-module imports" section above.
type PathSlot = {
  storePath: string | null;
  storeKeyPath: string | null;
};

type VellumAssistantNamespace = {
  storePathOverride?: PathSlot;
};

function pathSlot(): PathSlot {
  const g = globalThis as { vellumAssistant?: VellumAssistantNamespace };
  const ns = (g.vellumAssistant ??= {});
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
