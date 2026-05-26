/**
 * Test-only utilities for overriding the encrypted credential store paths.
 *
 * Replaces the removed `_setStorePath` and `_setStoreKeyPath` exports
 * from `encrypted-store.ts`. Lives here (not in the source module)
 * because production modules should not expose test backdoors, and
 * because importing from this file pulls only the stdlib-only
 * `store-path-override.ts` — never the crypto code in
 * `encrypted-store.ts`.
 *
 * Most tests no longer need these overrides: the test preload places
 * `VELLUM_WORKSPACE_DIR` at `<tmpRoot>/workspace`, so `getProtectedDir()`
 * resolves to `<tmpRoot>/protected` per process. The setters here exist
 * for the small set of tests that exercise specific path scenarios
 * (env-var fallbacks, migration corner cases, etc.).
 *
 * See `src/security/store-path-override.ts` for the underlying state
 * contract.
 */

import {
  setStoreKeyPathOverride,
  setStorePathOverride,
} from "../security/store-path-override.js";

/**
 * Override the encrypted store file path. Pass `null` to reset to the
 * default (`<protectedDir>/keys.enc`).
 */
export function setStorePathForTesting(path: string | null): void {
  setStorePathOverride(path);
}

/**
 * Override the store-key file path. Pass `null` to reset to the default
 * (`<dirname(storePath)>/store.key`).
 */
export function setStoreKeyPathForTesting(path: string | null): void {
  setStoreKeyPathOverride(path);
}
