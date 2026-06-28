/**
 * Runtime resync of the built-in memory tools (`remember`/`recall`) against the
 * live memory-capability set.
 *
 * `initializeTools()` registers the built-in memory tools only when the built-in
 * memory provider is NOT yielding to an external `provides: "memory"` plugin
 * (see `getMemoryToolsForActiveProvider`). That decision is made once, at boot.
 * But memory-capability discovery refreshes on later plugin scans
 * (`plugins/mtime-cache.ts`), so a `provides: "memory"` plugin installed or
 * enabled AFTER startup would otherwise leave the already-registered core
 * `remember`/`recall` tools in place — the plugin's same-named tools would then
 * be skipped as core-tool conflicts, keeping capture on the built-in until a
 * restart.
 *
 * {@link reconcileBuiltinMemoryTools} closes that gap: it makes registry tool
 * ownership track the live yield decision, so a memory plugin can take over (and
 * hand back) capture without a restart. It is idempotent and cheap, so the
 * mtime-cache calls it whenever the active memory-capability set changes.
 */

import { getConfig } from "../../config/loader.js";
import { resolveMemoryProvider } from "../../memory/provider/resolve.js";
import { shouldBuiltinMemoryYield } from "../../plugins/memory-capability.js";
import { getLogger } from "../../util/logger.js";
import {
  reclaimPluginToolNameForCore,
  registerTool,
  unregisterCoreTool,
} from "../registry.js";
import { getMemoryToolsForActiveProvider } from "../tool-manifest.js";
import { recallTool, rememberTool } from "./register.js";

const log = getLogger("builtin-memory-tool-sync");

/**
 * Canonical names of the provider-owned memory tools. Every memory provider
 * that exposes capture/recall contributes these exact definitions
 * (`provideTools()` returns `rememberTool`/`recallTool`), so they are the names
 * a config change may add or remove as the resolved provider changes.
 */
const MEMORY_TOOL_NAMES: readonly string[] = [
  rememberTool.name,
  recallTool.name,
];

/**
 * Reconcile the built-in memory tools in the global registry against the live
 * yield decision:
 *
 * - When the built-in should yield (an external memory plugin is active), strip
 *   the built-in `remember`/`recall` from the registry — but only while they are
 *   still core (unowned); a tool already owned by the external plugin is left
 *   untouched. Freeing the names lets the plugin's same-named tools register
 *   cleanly on its activation.
 * - When the built-in should not yield (no external memory plugin), reclaim each
 *   built-in tool name from a same-named external memory plugin tool that may
 *   still own it, then register the active provider's memory tools so capture
 *   returns to the built-in as a clean core tool. Idempotent via the registry's
 *   same-definition short-circuit. With the name reclaimed as core, the plugin's
 *   same-named tool is skipped as a core conflict on the next plugin scan,
 *   mirroring how the yield direction frees the names for the plugin.
 *
 * Resolves the built-in tool definitions from the active provider, so a
 * `memory.provider: "none"` install (which contributes no tools) is a no-op in
 * both directions. Never throws — a resync failure must not break a plugin scan.
 */
export function reconcileBuiltinMemoryTools(): void {
  try {
    const builtinMemoryTools =
      resolveMemoryProvider(getConfig()).provideTools();
    if (builtinMemoryTools.length === 0) return;

    if (shouldBuiltinMemoryYield()) {
      for (const tool of builtinMemoryTools) {
        if (tool.name === undefined) continue;
        if (unregisterCoreTool(tool.name)) {
          log.info(
            { name: tool.name },
            "Built-in memory tool yielded to an active external memory plugin",
          );
        }
      }
      return;
    }

    for (const tool of builtinMemoryTools) {
      if (tool.name !== undefined) {
        const displaced = reclaimPluginToolNameForCore(tool.name);
        if (displaced !== undefined) {
          log.info(
            { name: tool.name, plugin: displaced },
            "Built-in memory tool reclaimed from a yielding external memory plugin",
          );
        }
      }
      registerTool(tool);
    }
  } catch (err) {
    log.warn(
      { err },
      "Built-in memory tool resync failed; tool ownership may lag the active memory-plugin set until restart",
    );
  }
}

/**
 * Reconcile the provider-owned memory tools after a live config change so the
 * registry tracks the newly-resolved `memory.provider` without a restart.
 *
 * `initializeTools()` registers `remember`/`recall` once at boot from the
 * provider resolved then. Live config writes (`PATCH /v1/config`, `config/set`)
 * persist a new `memory.provider` but do not re-run tool init, so a running
 * assistant would otherwise keep the old tool surface: switching to
 * `provider: "none"` would leave the model-visible `remember`/`recall`
 * registered, and switching back to a real provider would not add them.
 *
 * Reconciliation is symmetric and reuses the resolved provider as the single
 * source of truth:
 * - Each canonical memory tool the active provider no longer provides
 *   (`provider: "none"`, or a provider that yields to an external memory
 *   plugin) is stripped while it is still an unowned core tool —
 *   {@link unregisterCoreTool} never evicts a plugin-owned tool.
 * - {@link reconcileBuiltinMemoryTools} then registers the active provider's
 *   memory tools (reclaiming a name from a yielding plugin first), so switching
 *   to a real provider restores capture.
 *
 * Idempotent in both directions, so callers may invoke it on any config write;
 * keeping it a no-op when `memory.provider` is unchanged is the caller's job
 * (this skips the work when the resolved id did not move). Never throws — a
 * resync failure must not break the config write that triggered it.
 */
export function reconcileMemoryToolsForConfigChange(): void {
  try {
    const desiredNames = new Set(
      getMemoryToolsForActiveProvider()
        .map((tool) => tool.name)
        .filter((name): name is string => name !== undefined),
    );
    for (const name of MEMORY_TOOL_NAMES) {
      if (!desiredNames.has(name) && unregisterCoreTool(name)) {
        log.info(
          { name },
          "Provider-owned memory tool unregistered: resolved memory provider no longer provides it",
        );
      }
    }
    reconcileBuiltinMemoryTools();
  } catch (err) {
    log.warn(
      { err },
      "Memory tool resync after config change failed; tool surface may lag the resolved memory provider until restart",
    );
  }
}
