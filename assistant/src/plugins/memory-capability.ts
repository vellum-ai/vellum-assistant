/**
 * Memory-capability arbiter — enforces the single-active-memory-plugin rule.
 *
 * The conversation's memory system (per-turn `<memory>` injection + post-turn
 * consolidation enqueue) is owned by exactly one plugin at a time. The built-in
 * memory plugins (`memory-retrieval`, `memory-v3-shadow`) provide it by default.
 * An external plugin can take over by declaring `vellum.provides === "memory"`
 * in its `package.json`; when such a plugin is installed and enabled — and the
 * `memory-plugin-provider` rollout flag is on — the built-in memory plugins
 * yield, their hooks filtered out at read time so they contribute neither
 * injection nor turn-commit work. The flag is off by default, so the built-in
 * memory system stays active regardless of installed plugins until a deployment
 * opts in.
 *
 * "Active" is read from the live mtime-cache discovery set
 * ({@link getDiscoveredMemoryCapabilityPlugins}), so installing, disabling, or
 * removing an external memory plugin takes effect on the next turn without a
 * restart — the same read-time semantics as the `.disabled` sentinel.
 *
 * Two simultaneously-active external memory plugins is a misconfiguration: the
 * built-in cannot yield to both. {@link assertSingleMemoryPlugin} throws a clear
 * error so bootstrap can surface it loudly; the read-time guards fail safe by
 * leaving the built-in active rather than silently routing to an arbitrary
 * external plugin.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfigReadOnly } from "../config/loader.js";
import { getDiscoveredMemoryCapabilityPlugins } from "./mtime-cache.js";
import { PluginExecutionError } from "./types.js";

/**
 * Rollout flag (scope `"both"` so the daemon reads it) gating whether an
 * external `provides: "memory"` plugin may take over from the built-in memory
 * system. Off by default: the built-in memory plugins stay active even when an
 * external memory plugin is installed, until a deployment opts in.
 */
const MEMORY_PLUGIN_PROVIDER_FLAG = "memory-plugin-provider" as const;

/**
 * Whether external memory-capability plugins are permitted to override the
 * built-in memory system. Reads the flag from the gateway-populated cache
 * (`isAssistantFeatureFlagEnabled` ignores the config arg); `getConfigReadOnly`
 * is a cheap cached read that never writes, safe to call in the read-time
 * `getHooksFor` path.
 */
function isMemoryPluginProviderEnabled(): boolean {
  return isAssistantFeatureFlagEnabled(
    MEMORY_PLUGIN_PROVIDER_FLAG,
    getConfigReadOnly(),
  );
}

/**
 * Built-in plugin names that provide the memory system. These yield when an
 * external `provides: "memory"` plugin is active. Recognized by name (not by a
 * manifest `provides` field) because they are first-party defaults.
 */
const BUILTIN_MEMORY_PLUGIN_NAMES: ReadonlySet<string> = new Set([
  "memory-retrieval",
  "memory-v3-shadow",
]);

/**
 * Whether `pluginName` is one of the built-in memory plugins that must yield to
 * an active external memory-capability plugin.
 */
export function isBuiltinMemoryPlugin(pluginName: string): boolean {
  return BUILTIN_MEMORY_PLUGIN_NAMES.has(pluginName);
}

/**
 * The enabled external plugins currently declaring `provides: "memory"`, read
 * from the live mtime-cache discovery set. Empty when the
 * `memory-plugin-provider` rollout flag is off, so the built-in memory system
 * stays active (and no single-plugin conflict is raised) regardless of what is
 * installed until a deployment opts in.
 */
export function getActiveExternalMemoryPlugins(): string[] {
  if (!isMemoryPluginProviderEnabled()) return [];
  return getDiscoveredMemoryCapabilityPlugins();
}

/**
 * Whether the built-in memory plugins should yield this read. True when exactly
 * one external memory-capability plugin is active. When two or more are active
 * we fail safe (return false → built-in stays active) rather than route to an
 * arbitrary one; {@link assertSingleMemoryPlugin} surfaces the misconfiguration.
 */
export function shouldBuiltinMemoryYield(): boolean {
  return getActiveExternalMemoryPlugins().length === 1;
}

/**
 * Throw when two or more external memory-capability plugins are active
 * simultaneously — only one plugin may own the conversation's memory system.
 * Called at bootstrap so the misconfiguration is surfaced loudly at startup.
 * A single active external memory plugin (or none) is valid and returns.
 */
export function assertSingleMemoryPlugin(): void {
  const active = getActiveExternalMemoryPlugins();
  if (active.length > 1) {
    throw new PluginExecutionError(
      `multiple memory-capability plugins are active (${active
        .sort()
        .join(
          ", ",
        )}) — at most one plugin may declare provides: "memory". Disable all but one and restart.`,
      undefined,
    );
  }
}
