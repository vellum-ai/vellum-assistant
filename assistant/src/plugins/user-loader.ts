/**
 * User plugin loader — discovers plugins under `~/.vellum/plugins/*` and
 * invokes each plugin's registration side effect via a dynamic import.
 *
 * A user plugin is a directory under `vellumRoot()/plugins/` that contains a
 * `register.ts` (or `register.js` after compilation). The file is expected to
 * call {@link registerPlugin} at import time so the plugin ends up in the
 * registry before {@link bootstrapPlugins} runs during daemon startup.
 *
 * The loader deliberately:
 *
 * - Uses {@link vellumRoot} rather than `homedir()` directly so the
 *   multi-instance invariant in the root CLAUDE.md holds — each instance
 *   loads its own plugin set from its own `.vellum` directory.
 * - Prefers `register.js` over `register.ts` when both exist (compiled plugins
 *   always win; this matches how `bun`/Node consumers resolve modules at
 *   runtime in the compiled binary).
 * - Treats any error from the dynamic import as a per-plugin isolation
 *   boundary: the offending directory is logged with `"Failed to load user
 *   plugin <dir>: <err>"` and the loader moves on to the next candidate.
 *   One bad user plugin must not crash the daemon.
 * - Bounds each dynamic import with a timeout
 *   ({@link USER_PLUGIN_IMPORT_TIMEOUT_MS}) so a plugin whose top-level
 *   `await` hangs or whose module evaluation never resolves cannot stall
 *   daemon startup. Timed-out plugins are logged and skipped just like
 *   thrown-error plugins.
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
import { vellumRoot } from "../util/platform.js";

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
 * Scan `vellumRoot()/plugins/` for subdirectories containing a
 * `register.{ts,js}` file, and dynamic-import each one so the module's
 * side-effecting {@link registerPlugin} calls populate the registry.
 *
 * Invariants:
 *
 * - No-ops when `vellumRoot()/plugins/` does not exist — a clean install with
 *   zero user plugins must not generate errors.
 * - Per-plugin isolation: a failing import is logged and skipped. The
 *   function resolves normally even when every plugin fails to load.
 * - Does not return plugin instances. The registry is the single source of
 *   truth for who got registered, and the caller inspects it directly.
 *
 * Must be called after first-party plugin side-effect imports have run and
 * before {@link bootstrapPlugins} — see the module docstring for the ordering
 * contract.
 */
export async function loadUserPlugins(
  options: { importTimeoutMs?: number } = {},
): Promise<void> {
  const importTimeoutMs =
    options.importTimeoutMs ?? USER_PLUGIN_IMPORT_TIMEOUT_MS;
  const pluginsDir = join(vellumRoot(), "plugins");
  if (!existsSync(pluginsDir)) {
    log.debug(
      { pluginsDir },
      "loadUserPlugins: no plugins directory — skipping",
    );
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

    // Prefer the compiled `register.js` over the TypeScript source. In the
    // bun-compiled daemon binary only the compiled file can be imported;
    // in development both may exist, in which case resolving the compiled
    // artifact matches how the runtime would behave in production.
    const jsPath = join(pluginDir, "register.js");
    const tsPath = join(pluginDir, "register.ts");
    let registerPath: string | undefined;
    if (existsSync(jsPath)) {
      registerPath = jsPath;
    } else if (existsSync(tsPath)) {
      registerPath = tsPath;
    }
    if (!registerPath) {
      log.debug(
        { pluginDir },
        "loadUserPlugins: no register.{ts,js} — skipping",
      );
      continue;
    }

    // `import()` with a `file://` URL works identically under Node and bun
    // and sidesteps platform-specific absolute-path quirks on Windows.
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
      const result = await Promise.race([import(moduleUrl), timeoutPromise]);
      if (result === timeoutSentinel) {
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
}
