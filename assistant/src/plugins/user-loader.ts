/**
 * User plugin loader — discovers plugins under `<workspaceDir>/plugins/*` via
 * one of two paths, gated by the contents of each candidate directory.
 *
 * **Experimental plugin framework path** (`package.json` present): the
 * harness walks the plugin's interface dirs (`hooks/`, `tools/`) and reads
 * the **default export** from each surface file via
 * {@link loadExperimentalPlugin}. The constructed `Plugin` is handed to
 * {@link registerPlugin} directly. No central `register.ts`, no
 * side-effect registration.
 *
 * **Legacy path** (`register.{ts,js}` present): the file is dynamic-imported
 * and expected to call {@link registerPlugin} at import time as a side
 * effect, populating the registry before {@link bootstrapPlugins} runs.
 *
 * A directory that matches neither path is skipped silently.
 *
 * The loader deliberately:
 *
 * - Uses `getWorkspaceDir()` so each instance loads its own plugin set
 *   when `VELLUM_WORKSPACE_DIR` is set.
 * - Prefers `.js` over `.ts` for every surface file when both exist
 *   (compiled plugins always win; this matches how `bun`/Node consumers
 *   resolve modules at runtime in the compiled binary). The experimental
 *   loader applies the same rule per surface file; the legacy path picks
 *   between `register.js` and `register.ts`.
 * - Treats any error from a plugin load as a per-plugin isolation
 *   boundary: the offending directory is logged and the loader moves on
 *   to the next candidate. One bad user plugin must not crash the daemon.
 * - Bounds each plugin load with a timeout
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
import { getWorkspaceDir } from "../util/platform.js";
import { loadExperimentalPlugin } from "./experimental-plugin-loader.js";
import { closeRegistration, registerPlugin } from "./registry.js";

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
 * Scan `getWorkspaceDir()/plugins/` for subdirectories containing a
 * `register.{ts,js}` file, and dynamic-import each one so the module's
 * side-effecting {@link registerPlugin} calls populate the registry.
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
 * Must be called after first-party plugin side-effect imports have run and
 * before {@link bootstrapPlugins} — see the module docstring for the ordering
 * contract.
 */
export async function loadUserPlugins(
  options: { importTimeoutMs?: number } = {},
): Promise<void> {
  const importTimeoutMs =
    options.importTimeoutMs ?? USER_PLUGIN_IMPORT_TIMEOUT_MS;
  const pluginsDir = join(getWorkspaceDir(), "plugins");
  if (!existsSync(pluginsDir)) {
    log.debug(
      { pluginsDir },
      "loadUserPlugins: no plugins directory — skipping",
    );
    // Close the registration window even on the fast path so a late arrival
    // from an unrelated source (e.g. a mis-ordered static import) still can't
    // slip in after bootstrap walks the registry.
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

    // Experimental plugin framework branch: a directory with a
    // `package.json` is loaded by walking its interface dirs (`hooks/`,
    // `tools/`) and reading the **default export** from each surface file.
    // The harness builds the `Plugin` object and calls `registerPlugin()`
    // directly — no central `register.ts`, no side-effect registration on
    // this path. Same per-plugin isolation + timeout boundary as the
    // legacy path: a bad/hung experimental plugin must not crash startup.
    if (existsSync(join(pluginDir, "package.json"))) {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutSentinel = Symbol("experimental-plugin-load-timeout");
        const loadPromise = loadExperimentalPlugin(pluginDir);
        const timeoutPromise = new Promise<typeof timeoutSentinel>(
          (resolve) => {
            timeoutHandle = setTimeout(
              () => resolve(timeoutSentinel),
              importTimeoutMs,
            );
          },
        );
        const result = await Promise.race([loadPromise, timeoutPromise]);
        if (result === timeoutSentinel) {
          loadPromise.catch(() => {
            // Abandoned load — closed-registration latch rejects any late
            // `registerPlugin()` from the resolved value's surface imports.
          });
          log.warn(
            { pluginDir, timeoutMs: importTimeoutMs },
            `Timed out loading experimental plugin ${pluginDir} after ${importTimeoutMs}ms — skipping`,
          );
        } else {
          registerPlugin(result);
          log.info(
            { pluginDir, name: result.manifest.name },
            "loaded experimental plugin",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err, pluginDir },
          `Failed to load experimental plugin ${pluginDir}: ${message}`,
        );
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
      continue;
    }

    // Legacy register.{ts,js} side-effect path. Prefer the compiled
    // `register.js` over the TypeScript source. In the bun-compiled daemon
    // binary only the compiled file can be imported; in development both
    // may exist, in which case resolving the compiled artifact matches how
    // the runtime would behave in production.
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
        "loadUserPlugins: no register.{ts,js} or package.json — skipping",
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
