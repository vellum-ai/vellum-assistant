/**
 * Installs the test-only DB migration-template cache onto the shared
 * `globalThis.vellumAssistant.dbTemplateCache` slot that
 * `persistence/db-init.ts` reads. Called once from the test preload, alongside
 * the other `install*()` mocks.
 *
 * Preload-safe by construction
 * ----------------------------
 * The test preload must not pull the heavy persistence graph (drizzle, schema)
 * in at import time — that is the DB-ghost hazard the isolation rule guards
 * against. So this module has ZERO static `src/` imports: the real
 * implementation in `db-template-helpers.ts` (which does import `src/`) is
 * loaded via a lazy `require()` on the FIRST `initializeDb()` call, i.e. at
 * test-execution time after the workspace override is set.
 *
 * The slot shape is duplicated here on purpose (it also lives in
 * `db-init.ts`) — matching the `dbSingletons` / `featureFlagCache` pattern, the
 * production owner and the test installer reference the shared namespace
 * independently and neither imports the other.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Mirrors `DbTemplateCache` in `persistence/db-init.ts`. Duplicated by design —
// see the module comment above.
type DbTemplateCache = {
  tryRestore(): boolean;
  save(): void;
};

type VellumAssistantNamespace = {
  dbTemplateCache?: DbTemplateCache | null;
};

export function installDbTemplateCache(): void {
  const g = globalThis as { vellumAssistant?: VellumAssistantNamespace };
  const ns = (g.vellumAssistant ??= {});
  // Lazy require: defers loading the persistence graph until a test actually
  // calls initializeDb(), keeping the preload's import chain free of `src/`.
  const impl = () =>
    require("./db-template-helpers.js") as typeof import("./db-template-helpers.js");
  ns.dbTemplateCache = {
    tryRestore: () => impl().tryRestoreTemplate(),
    save: () => impl().saveTemplate(),
  };
}
