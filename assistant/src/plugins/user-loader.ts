/**
 * User plugin loader — discovers plugins under `<workspaceDir>/plugins/*` and
 * registers each one.
 *
 * A plugin directory is recognized by a `package.json` manifest. The harness
 * delegates to {@link loadExternalPlugin}, which builds a `Plugin` from the
 * directory's interface dirs (`hooks/`, `tools/`) and registers it directly.
 * The full convention lives in
 * `assistant/src/plugins/external-plugin-loader.ts`. A directory with no
 * `package.json` is skipped silently.
 *
 * The loader deliberately:
 *
 * - Uses `getWorkspaceDir()` so each instance loads its own plugin set
 *   when `VELLUM_WORKSPACE_DIR` is set.
 * - Prefers `.js` over `.ts` per surface file (compiled-binary semantics);
 *   the rule is applied by {@link loadExternalPlugin}.
 * - Treats any error from a plugin load as a per-plugin isolation
 *   boundary. {@link loadExternalPlugin} owns its own try/catch/timeout, so
 *   one bad user plugin must not crash the daemon.
 *
 * Call order relative to the rest of the plugin system:
 *
 *     first-party default registrations (explicit, at daemon startup)
 *       → loadUserPlugins()          ← this module (closes registration)
 *         → bootstrapPlugins()       (init for everyone registered so far)
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 29).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspacePluginsDir } from "../util/platform.js";
import { ensurePluginApiShim } from "./ensure-plugin-api-shim.js";
import { loadExternalPlugin } from "./external-plugin-loader.js";
import { closeRegistration } from "./registry.js";

const log = getLogger("user-plugin-loader");

/**
 * Upper bound on how long a single user plugin's load may take. A plugin with
 * a hanging top-level `await` (or a never-resolving module evaluation) would
 * otherwise block daemon startup indefinitely. Ten seconds is generous
 * relative to a typical plugin load (milliseconds) and matches the per-plugin
 * isolation contract: slow plugins get skipped the same way thrown-error
 * plugins do. Enforced by {@link loadExternalPlugin}.
 */
const USER_PLUGIN_IMPORT_TIMEOUT_MS = 10_000;

/**
 * Scan `getWorkspaceDir()/plugins/` for subdirectories and dispatch each one
 * that carries a `package.json` to {@link loadExternalPlugin}.
 *
 * Invariants:
 *
 * - No-ops when `getWorkspaceDir()/plugins/` does not exist — a clean install with
 *   zero user plugins must not generate errors.
 * - Per-plugin isolation: a failing load is logged and skipped. The
 *   function resolves normally even when every plugin fails to load.
 * - Does not return plugin instances. The registry is the single source of
 *   truth for who got registered, and the caller inspects it directly.
 *
 * Caller responsibilities:
 *
 * - Must be invoked exactly once during daemon startup, before
 *   `bootstrapPlugins()` walks the registry.
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

  const pluginsDir = getWorkspacePluginsDir();

  if (!existsSync(pluginsDir)) {
    // The clean-install case. Closing the registration window keeps the
    // post-loader invariant uniform: `bootstrapPlugins()` may rely on the
    // registry being final by the time `loadUserPlugins()` resolves.
    closeRegistration();
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(pluginsDir);
  } catch (err) {
    // Permissions error, transient FS issue, etc. Log and bail without
    // crashing startup — the daemon must come up even when the plugins dir
    // is unreadable.
    log.warn(
      { err, pluginsDir },
      "loadUserPlugins: failed to read plugins directory",
    );
    closeRegistration();
    return;
  }

  for (const entry of entries) {
    const pluginDir = join(pluginsDir, entry);

    // Only directories are candidates. Plain files (readmes, stray configs)
    // are silently ignored.
    let stats;
    try {
      stats = statSync(pluginDir);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;

    if (!existsSync(join(pluginDir, "package.json"))) {
      log.debug({ pluginDir }, "loadUserPlugins: no package.json — skipping");
      continue;
    }

    // `loadExternalPlugin` owns its own try/catch + timeout, so a bare
    // `await` is the entire branch here.
    await loadExternalPlugin(pluginDir, { importTimeoutMs });
  }

  // Close the registration window once every candidate plugin has been
  // awaited (or timed out). The per-plugin try/catch inside
  // `loadExternalPlugin` guarantees no throw escapes the loop, so this line
  // always runs and `bootstrapPlugins()` sees a fully populated registry.
  closeRegistration();
}
