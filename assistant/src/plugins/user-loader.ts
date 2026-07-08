/**
 * User plugin loader — discovers plugins under `<workspaceDir>/plugins/*` and
 * populates the mtime cache.
 *
 * A plugin directory is recognized by a `package.json` manifest. The loader
 * delegates to the mtime cache's `populateCacheAtBoot`, which builds each
 * plugin via `buildExternalPlugin` and stores it keyed by mtime. The cache
 * is the single source of truth for user plugin state — the registry is no
 * longer used for user plugins (only for first-party defaults).
 *
 * The loader deliberately:
 *
 * - Uses `getWorkspaceDir()` so each instance loads its own plugin set
 *   when `VELLUM_WORKSPACE_DIR` is set.
 * - Prefers `.js` over `.ts` per surface file (compiled-binary semantics);
 *   the rule is applied by `buildExternalPlugin`.
 * - Treats any error from a plugin load as a per-plugin isolation
 *   boundary. `buildExternalPlugin` owns its own try/catch/timeout, so
 *   one bad user plugin must not crash the daemon.
 *
 * Call order relative to the rest of the plugin system:
 *
 *     first-party default registrations (explicit, at daemon startup)
 *       → loadUserPlugins()          ← this module (populates mtime cache)
 *         → bootstrapPlugins()       (init for defaults registered so far)
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 29).
 */

import { getLogger } from "../util/logger.js";
import { ensurePluginApiShim } from "./ensure-plugin-api-shim.js";
import { ensureSharedDepLinks } from "./ensure-shared-dep-links.js";
import { populateCacheAtBoot } from "./mtime-cache.js";

const log = getLogger("user-plugin-loader");

/**
 * Upper bound on how long a single user plugin's load may take. A plugin with
 * a hanging top-level `await` (or a never-resolving module evaluation) would
 * otherwise block daemon startup indefinitely. Ten seconds is generous
 * relative to a typical plugin load (milliseconds) and matches the per-plugin
 * isolation contract: slow plugins get skipped the same way thrown-error
 * plugins do. Enforced by `buildExternalPlugin`.
 */
const USER_PLUGIN_IMPORT_TIMEOUT_MS = 10_000;

/**
 * Scan `getWorkspaceDir()/plugins/` for subdirectories and populate the mtime
 * cache with each plugin found.
 *
 * Invariants:
 *
 * - No-ops when `getWorkspaceDir()/plugins/` does not exist — a clean install with
 *   zero user plugins must not generate errors.
 * - Per-plugin isolation: a failing load is logged and skipped. The
 *   function resolves normally even when every plugin fails to load.
 * - Does not return plugin instances. The mtime cache is the single source
 *   of truth for user plugin state, and consumers read from it directly.
 *
 * Caller responsibilities:
 *
 * - Must be invoked exactly once during daemon startup, before
 *   `bootstrapPlugins()` walks the registry (which now only contains
 *   first-party defaults).
 * - Holds no locks during the load — bun's dynamic `import()` resolution
 *   is concurrency-safe.
 */
export async function loadUserPlugins(
  options: { importTimeoutMs?: number } = {},
): Promise<void> {
  const importTimeoutMs =
    options.importTimeoutMs ?? USER_PLUGIN_IMPORT_TIMEOUT_MS;

  // Materialize the workspace-level `@vellumai/plugin-api` shim *before*
  // we dynamic-import any user plugins. The shim file must exist on disk
  // before the first plugin's `import "@vellumai/plugin-api"` is parsed.
  //
  // Wrapped in try/catch because per `AGENTS.md` the daemon must never
  // block startup. A shim-write failure (ENOSPC, read-only workspace,
  // perms) is logged and we continue — plugins that try to import the
  // public specifier will fail individually inside the per-plugin import
  // loop below, which is already isolated.
  try {
    await ensurePluginApiShim();
  } catch (err) {
    log.warn(
      { err },
      "loadUserPlugins: plugin-api shim materialization failed — continuing with degraded plugin support",
    );
  }

  // Same treatment for whitelisted shared deps (zod, …): the installer never
  // runs `bun install`, so a plugin's bare `import { z } from "zod"` only
  // resolves if we symlink the assistant's own copy into the workspace's
  // node_modules. ensureSharedDepLinks never throws for a single dep, but is
  // wrapped for the same never-block-startup reason as above.
  try {
    await ensureSharedDepLinks();
  } catch (err) {
    log.warn(
      { err },
      "loadUserPlugins: shared-dep link failed — plugins with runtime deps may not import",
    );
  }

  // Populate the mtime cache. This scans the plugins directory, builds
  // each plugin via buildExternalPlugin, and stores the results keyed by
  // mtime. The cache is the source of truth — no registry calls needed.
  await populateCacheAtBoot({ importTimeoutMs });
}
