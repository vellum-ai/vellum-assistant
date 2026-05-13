/**
 * User plugin loader — discovers plugins under `<workspaceDir>/plugins/*` via
 * one of two paths, gated by the contents of each candidate directory.
 *
 * **External plugin framework path** (`package.json` present **and** no
 * `register.{ts,js}`): the harness delegates to {@link loadExternalPlugin},
 * which builds a `Plugin` from the directory's interface dirs (`hooks/`,
 * `tools/`) and registers it directly. This path is opt-in by the plugin
 * author and currently experimental — see
 * `assistant/src/plugins/external-plugin-loader.ts` for the full
 * convention.
 *
 * **Legacy path** (`register.{ts,js}` present): the file is dynamic-imported
 * and expected to call {@link registerPlugin} at import time as a side
 * effect, populating the registry before {@link bootstrapPlugins} runs.
 *
 * The legacy path takes precedence when a directory contains both
 * `package.json` and `register.{ts,js}` — a migration-friendly default
 * that keeps existing plugins (including the in-repo `examples/plugins/echo`
 * reference) working unchanged while we iterate the external-plugin
 * convention. A directory matching neither path is skipped silently.
 *
 * The loader deliberately:
 *
 * - Uses `getWorkspaceDir()` so each instance loads its own plugin set
 *   when `VELLUM_WORKSPACE_DIR` is set.
 * - Prefers `.js` over `.ts` per surface file (compiled-binary semantics).
 *   The external loader applies the same rule per surface file; the
 *   legacy path picks between `register.js` and `register.ts`.
 * - Treats any error from a plugin load as a per-plugin isolation
 *   boundary. {@link loadExternalPlugin} owns its own try/catch/timeout;
 *   the legacy path is wrapped here. One bad user plugin must not crash
 *   the daemon.
 * - Bounds each plugin load with {@link USER_PLUGIN_IMPORT_TIMEOUT_MS}
 *   so a plugin whose top-level `await` hangs or whose module evaluation
 *   never resolves cannot stall daemon startup.
 *
 * Call order relative to the rest of the plugin system:
 *
 *     first-party registrations (static side-effect imports)
 *       → loadUserPlugins()          ← this module
 *         → bootstrapPlugins()       (init for everyone registered so far)
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 29).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { getLogger } from "../util/logger.js";
import { getWorkspacePluginsDir } from "../util/platform.js";
import { ensurePluginApiShim } from "./ensure-plugin-api-shim.js";
import { loadExternalPlugin } from "./external-plugin-loader.js";
import { closeRegistration } from "./registry.js";

const log = getLogger("user-plugin-loader");

/**
 * Upper bound on how long a single user plugin's dynamic `import()` may take.
 * A plugin with a hanging top-level `await` (or a never-resolving module
 * evaluation) would otherwise block daemon startup indefinitely, since a raw
 * `try/catch` only isolates thrown errors — not hung promises. Ten seconds is
 * generous relative to a typical side-effect registration (milliseconds) and
 * matches the per-plugin isolation contract: slow plugins get skipped the
 * same way thrown-error plugins do.
 */
const USER_PLUGIN_IMPORT_TIMEOUT_MS = 10_000;

/**
 * Scan `getWorkspaceDir()/plugins/` for subdirectories, then dispatch each
 * one to the external loader (if `package.json` is present and there is no
 * `register.{ts,js}`) or the legacy side-effect importer (if
 * `register.{ts,js}` is present).
 *
 * Invariants:
 *
 * - No-ops when `getWorkspaceDir()/plugins/` does not exist — a clean install with
 *   zero user plugins must not generate errors.
 * - Per-plugin isolation: a failing import is logged and skipped. The
 *   function resolves normally even when every plugin fails to load.
 * - Does not return plugin instances. The registry is the single source of
 *   truth for who got registered, and the caller inspects it directly.
 *
 * Caller responsibilities:
 *
 * - Must be invoked exactly once during daemon startup, before
 *   `bootstrapPlugins()` walks the registry.
 * - Holds no locks during the import — bun's dynamic `import()` resolution
 *   is concurrency-safe.
 */
export async function loadUserPlugins(
  options: { importTimeoutMs?: number } = {},
): Promise<void> {
  const importTimeoutMs = options.importTimeoutMs ?? USER_PLUGIN_IMPORT_TIMEOUT_MS;

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

    // Path selection: the legacy side-effect path takes precedence when
    // both a `register.{ts,js}` and a `package.json` are present.
    // Migration-friendly: any plugin in the wild today that happens to
    // ship a `package.json` keeps loading via its existing register entry.
    // The external-plugin path only fires when the directory is
    // unambiguously the new convention.
    const jsPath = join(pluginDir, "register.js");
    const tsPath = join(pluginDir, "register.ts");
    let registerPath: string | undefined;
    if (existsSync(jsPath)) {
      registerPath = jsPath;
    } else if (existsSync(tsPath)) {
      registerPath = tsPath;
    }

    if (registerPath === undefined) {
      // External plugin framework path. `loadExternalPlugin` owns its own
      // try/catch + timeout, so a `continue` is the entire branch here.
      if (existsSync(join(pluginDir, "package.json"))) {
        await loadExternalPlugin(pluginDir, { importTimeoutMs });
        continue;
      }
      log.debug(
        { pluginDir },
        "loadUserPlugins: no register.{ts,js} or package.json — skipping",
      );
      continue;
    }

    // Legacy side-effect import path. `import()` with a `file://` URL
    // works identically under Node and bun and sidesteps platform-specific
    // absolute-path quirks on Windows.
    const moduleUrl = pathToFileURL(registerPath).href;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      // Race the import against a timeout so a plugin with a hanging top-level
      // await or never-resolving module evaluation cannot stall daemon startup.
      // The per-plugin try/catch already handles thrown errors; this extends
      // the isolation boundary to cover hung promises as well.
      const timeoutSentinel = Symbol("user-plugin-import-timeout");
      const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve(timeoutSentinel),
          importTimeoutMs,
        );
      });
      // Retain the import promise so we can attach a terminal `.catch` on the
      // timeout branch. `Promise.race` does not cancel the losing promise —
      // the module evaluation keeps running in the background even after we
      // stop awaiting it, and if it eventually throws (either from the
      // module body or from the late `registerPlugin()` hitting a closed
      // registry) an unhandled rejection would crash the daemon.
      const importPromise = import(moduleUrl);
      const result = await Promise.race([importPromise, timeoutPromise]);
      if (result === timeoutSentinel) {
        importPromise.catch(() => {
          // Abandoned import completed (or threw) after the timeout. The
          // closed-registration latch in registry.ts guarantees any late
          // `registerPlugin()` call is rejected, so swallowing the outcome
          // here is the safe default.
        });
        log.warn(
          { pluginDir, registerPath, timeoutMs: importTimeoutMs },
          `Timed out loading user plugin ${pluginDir} after ${importTimeoutMs}ms — skipping`,
        );
      } else {
        log.info(
          { pluginDir, registerPath },
          "loaded user plugin (side-effect import completed)",
        );
      }
    } catch (err) {
      // One plugin's failure must never prevent other plugins from loading
      // or crash the daemon. Log with the directory name so operators can
      // find the broken plugin quickly.
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, pluginDir },
        `Failed to load user plugin ${pluginDir}: ${message}`,
      );
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  // Close the registration window once every candidate plugin has been
  // awaited (or timed out). The per-plugin try/catch guarantees no throw
  // escapes the loop, so this line always runs. Any abandoned import that
  // later resolves and reaches `registerPlugin()` is rejected by the latch,
  // preserving the `bootstrapPlugins()` invariant that the registry is
  // fully populated before it is walked.
  closeRegistration();
}
