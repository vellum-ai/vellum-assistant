/**
 * Hook registry — the per-surface registry for in-process (default plugin)
 * hooks. Each hook name maps to an ordered list of `{fn, pluginName}`
 * entries, one per plugin that contributes that hook. The list order matches
 * registration order (i.e. `getAllDefaultPlugins` array order), which fixes
 * hook-chain ordering.
 *
 * User-land hooks (from the filesystem) are owned by
 * {@link ./hook-loader.ts} and surfaced through `getUserHooksFor` in
 * `plugins/mtime-cache.ts`. This module owns only the in-process hooks that
 * default plugins register at boot.
 *
 * {@link getHooksFor} combines both sources: in-process hooks from this
 * registry (filtered by `isPluginDisabled` at read time) and user-land hooks
 * from the mtime cache. The read-time filtering is what makes `assistant
 * plugins disable default-*` take effect immediately in a running assistant
 * — the hooks stay registered but are filtered out on the next turn.
 */

import { isPluginDisabled } from "../plugins/disabled-state.js";
import {
  isFullyYieldableBuiltinMemoryPlugin,
  shouldBuiltinMemoryYield,
} from "../plugins/memory-capability.js";
import { getUserHooksFor } from "../plugins/mtime-cache.js";
import type { HookFunction } from "../plugins/types.js";

// ─── Internal state ──────────────────────────────────────────────────────────

/**
 * Hook registry keyed by hook name. Each value is an ordered list of
 * `{fn, pluginName}` entries in registration order.
 */
const hookRegistry = new Map<
  string,
  Array<{ fn: HookFunction; pluginName: string }>
>();

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Register all hooks from a plugin's `hooks` map. Each hook is appended to
 * the list for its hook name, preserving registration order. Called by
 * `registerDefaultPlugins` at boot and by `loadExternalPlugin` for test
 * fixtures.
 */
export function registerPluginHooks(
  pluginName: string,
  hooks: Record<string, HookFunction>,
): void {
  for (const [hookName, fn] of Object.entries(hooks)) {
    if (typeof fn !== "function") continue;
    let list = hookRegistry.get(hookName);
    if (!list) {
      list = [];
      hookRegistry.set(hookName, list);
    }
    list.push({ fn: fn as HookFunction, pluginName });
  }
}

/**
 * Remove all hooks contributed by `pluginName` from the registry. Used by
 * the bootstrap failure path (init threw) and the feature-flag skip path —
 * both are boot-time decisions where the plugin's hooks should never
 * participate in the turn lifecycle.
 */
export function unregisterPluginHooks(pluginName: string): void {
  for (const [, list] of hookRegistry) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.pluginName === pluginName) {
        list.splice(i, 1);
      }
    }
  }
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Collect every registered hook for the given name, in registration order.
 * Plugins that don't declare a hook for `name` are skipped. Used by the
 * daemon to invoke chain-style hooks like `user-prompt-submit` where each
 * plugin's hook may transform a shared context.
 *
 * In-process default plugin hooks are read from this registry (synchronous)
 * and filtered by the `.disabled` sentinel at read time via
 * {@link isPluginDisabled}. User-land hooks are pulled from the mtime cache
 * (async, may re-import). Default hooks are prepended so they compose
 * innermost, ahead of any user plugins.
 *
 * The `TCtx` generic mirrors {@link HookFunction}'s — callers parameterize
 * over the concrete context type their hook receives. Hooks that mutate the
 * context in place return `void`; hooks that return a new context replace
 * the threaded value for the next hook in the chain.
 */
export async function getHooksFor<TCtx = unknown>(
  name: string,
): Promise<HookFunction<TCtx>[]> {
  // User-land hooks from the mtime cache (async, may re-import). Fetched first
  // because the same call refreshes plugin discovery — including the
  // memory-capability set the built-in-yield check below reads — so an external
  // memory plugin installed/removed this turn is reflected immediately.
  const userHooks = await getUserHooksFor<TCtx>(name);

  // When an external `provides: "memory"` plugin is active, the built-in memory
  // system yields. The drop here is MEMORY-SPECIFIC: only PURE-memory plugins
  // (`memory-v3-shadow`) have their hooks dropped wholesale. `memory-retrieval`
  // keeps running — it also drives general runtime assembly, so dropping it
  // would lose the non-memory `<turn_context>` / workspace / PKB / NOW / channel
  // blocks every turn; it instead suppresses only its memory portion downstream
  // (`isBuiltinMemoryInjectionSuppressed`). Read-time, like the `.disabled`
  // sentinel. Two active external memory plugins fail safe (built-in stays
  // active); `assertSingleMemoryPlugin` surfaces that misconfiguration.
  const builtinMemoryYields = shouldBuiltinMemoryYield();

  // First-party defaults from the hook registry, filtered by the `.disabled`
  // sentinel at read time. This is what makes `assistant plugins disable
  // default-*` take effect immediately in a running assistant: the hooks stay
  // registered but are filtered out on the next turn.
  const defaultHooks: HookFunction<TCtx>[] = [];
  for (const entry of hookRegistry.get(name) ?? []) {
    if (isPluginDisabled(entry.pluginName)) continue;
    if (
      builtinMemoryYields &&
      isFullyYieldableBuiltinMemoryPlugin(entry.pluginName)
    )
      continue;
    defaultHooks.push(entry.fn as HookFunction<TCtx>);
  }

  return [...defaultHooks, ...userHooks];
}

// ─── Test hooks ──────────────────────────────────────────────────────────────

/**
 * Clear the hook registry. Test-only — throws when invoked outside a test
 * environment so application code can never accidentally wipe the registry
 * at runtime.
 */
export function resetHookRegistryForTests(): void {
  const isTest =
    process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
  if (!isTest) {
    throw new Error(
      "resetHookRegistryForTests may only be called in test environments",
    );
  }
  hookRegistry.clear();
}
