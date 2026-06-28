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

const log = getLogger("builtin-memory-tool-sync");

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
