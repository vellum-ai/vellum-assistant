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
 *
 * When `conversationId` is given, the conversation's effective plugin scope is
 * resolved from it (memory, then DB) and layered on top of the global disabled
 * check: a hook's contributing plugin must also be a member of that set or the
 * hook is excluded for this turn (applies to both in-process default plugins
 * and user-land plugins). Omit it (or pass a conversation with no per-chat
 * restriction) and every globally-enabled plugin's hooks run, unchanged.
 */
export async function getHooksFor<TCtx = unknown>(
  name: string,
  options?: { conversationId?: string },
): Promise<HookFunction<TCtx>[]> {
  // Resolve the per-chat scope through a lazy import: a static import of the
  // daemon resolver would add `hooks/ → daemon/conversation-tool-setup` to the
  // module-init graph and perturb the capability-seed init order. Importing at
  // call time keeps that edge out of module evaluation (this only runs at
  // hook-dispatch, well after boot). The module is cached after the first load.
  let effectiveEnabledPlugins: Set<string> | null = null;
  if (options?.conversationId) {
    const { resolveConversationPluginScope } =
      await import("../daemon/conversation-plugin-scope.js");
    effectiveEnabledPlugins = resolveConversationPluginScope(
      options.conversationId,
    );
  }
  // First-party defaults from the hook registry, filtered by the `.disabled`
  // sentinel at read time. This is what makes `assistant plugins disable
  // default-*` take effect immediately in a running assistant: the hooks stay
  // registered but are filtered out on the next turn.
  const defaultHooks: HookFunction<TCtx>[] = [];
  for (const entry of hookRegistry.get(name) ?? []) {
    if (isPluginDisabled(entry.pluginName)) continue;
    if (
      effectiveEnabledPlugins != null &&
      !effectiveEnabledPlugins.has(entry.pluginName)
    ) {
      continue;
    }
    defaultHooks.push(entry.fn as HookFunction<TCtx>);
  }

  // User-land hooks from the mtime cache (async, may re-import). The per-chat
  // scope is threaded through so a deselected user plugin's hooks are excluded
  // too — standalone workspace hooks (not owned by a plugin) always run.
  const userHooks = await getUserHooksFor<TCtx>(name, effectiveEnabledPlugins);

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
