/**
 * Hook registry — the per-surface registry for in-process (default plugin)
 * hooks. Each hook name maps to an ordered list of `{fn, pluginName}`
 * entries, one per plugin that contributes that hook. The list order matches
 * registration order (i.e. `getAllDefaultPlugins` array order), which fixes
 * hook-chain ordering.
 *
 * User-land hooks (from the filesystem) are owned by
 * {@link ./hook-loader.ts} and surfaced through {@link getUserHooksFor}.
 * This module owns the in-process hooks that default plugins register at
 * boot, plus the user-land lookup that walks discovered plugin names from
 * the plugin cache.
 *
 * {@link getHooksFor} and {@link getUserHooksFor} both resolve through
 * {@link getUserHookEntriesFor}, which prepends in-process default-plugin
 * hooks from this registry (filtered by `isPluginDisabled` at read time)
 * ahead of user-land hooks from the plugin cache. The read-time filtering
 * is what makes `assistant plugins disable default-*` take effect immediately
 * in a running assistant: the hooks stay registered but are filtered out on
 * the next turn.
 */

import { isFirstPartyDefaultPlugin } from "../plugins/defaults/main.js";
import { isPluginDisabled } from "../plugins/disabled-state.js";
import { getDiscoveredUserPluginNames } from "../plugins/mtime-cache.js";
import type { HookEntry, HookFunction } from "../plugins/types.js";
import { collectUserHookEntries } from "./hook-loader.js";

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
    if (typeof fn !== "function") {
      continue;
    }
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
 * In-process (default plugin) hook entries for `name`, filtered by the
 * `.disabled` sentinel at read time. First-party default plugins always pass
 * the per-chat allowlist; other in-process registrations (test fixtures) honor
 * it. Used by {@link getUserHookEntriesFor} so `getUserHooksFor` returns the
 * same default-plugin hooks {@link getHooksFor} does.
 */
function collectInProcessHookEntries<TCtx = unknown>(
  name: string,
  effectiveEnabledPlugins?: Set<string> | null,
): HookEntry<TCtx>[] {
  const defaultEntries: HookEntry<TCtx>[] = [];
  for (const entry of hookRegistry.get(name) ?? []) {
    if (isPluginDisabled(entry.pluginName)) {
      continue;
    }
    if (
      effectiveEnabledPlugins != null &&
      !effectiveEnabledPlugins.has(entry.pluginName) &&
      !isFirstPartyDefaultPlugin(entry.pluginName)
    ) {
      continue;
    }
    defaultEntries.push({
      fn: entry.fn as HookFunction<TCtx>,
      owner: { kind: "plugin", id: entry.pluginName },
    });
  }
  return defaultEntries;
}

/**
 * Get all hooks for a given event name: in-process default-plugin hooks
 * first, then user plugins and standalone workspace hooks. Plugin hooks run
 * in install-date order, the workspace hook runs last.
 *
 * Default-plugin hooks come from the in-process registry (registration at
 * boot). User-land hooks are a pure cache read: this never scans disk,
 * activates a plugin, or runs `init`. Activation happens only at boot
 * (`populateCacheAtBoot`) and through the imperative install/uninstall
 * poke (`reconcilePluginSourcesNow`), both main-daemon paths, so a
 * sidecar process that dispatches hooks (a worker running conversation
 * turns) can never bring a plugin up in its own process.
 *
 * `effectiveEnabledPlugins` carries the per-chat plugin scope: when non-null,
 * user plugins outside the set are skipped. First-party default plugins
 * always pass that allowlist (a workspace `.disabled` sentinel still
 * excludes them). Standalone workspace hooks always run. `null`/omitted
 * means no per-chat restriction.
 */
export async function getUserHookEntriesFor<TCtx = unknown>(
  hookName: string,
  effectiveEnabledPlugins?: Set<string> | null,
): Promise<HookEntry<TCtx>[]> {
  const defaultEntries = collectInProcessHookEntries<TCtx>(
    hookName,
    effectiveEnabledPlugins,
  );
  const userEntries = await collectUserHookEntries<TCtx>(
    hookName,
    getDiscoveredUserPluginNames(),
    effectiveEnabledPlugins,
  );
  return [...defaultEntries, ...userEntries];
}

/**
 * {@link getUserHookEntriesFor} without owner attribution. Returns just the
 * hook functions in the same order, including in-process default-plugin hooks.
 */
export async function getUserHooksFor<TCtx = unknown>(
  hookName: string,
  effectiveEnabledPlugins?: Set<string> | null,
): Promise<HookFunction<TCtx>[]> {
  const entries = await getUserHookEntriesFor<TCtx>(
    hookName,
    effectiveEnabledPlugins,
  );
  return entries.map((e) => e.fn);
}

/**
 * Collect every registered hook for the given name, in registration order.
 * Plugins that don't declare a hook for `name` are skipped. Used by the
 * daemon to invoke chain-style hooks like `user-prompt-submit` where each
 * plugin's hook may transform a shared context.
 *
 * In-process default plugin hooks are read from this registry (synchronous)
 * and filtered by the `.disabled` sentinel at read time via
 * {@link isPluginDisabled}. User-land hooks are pulled from the plugin cache
 * (async, pure cache read). Default hooks are prepended so they compose
 * innermost, ahead of any user plugins.
 *
 * The `TCtx` generic mirrors {@link HookFunction}'s: callers parameterize
 * over the concrete context type their hook receives. Hooks that mutate the
 * context in place return `void`; hooks that return a new context replace
 * the threaded value for the next hook in the chain.
 *
 * When `conversationId` is given, the conversation's effective plugin scope is
 * resolved from it (memory, then DB) and layered on top of the global disabled
 * check: a user plugin must also be a member of that set or its hook is
 * excluded for this turn. First-party default plugins are not subject to the
 * per-chat allowlist (they are core runtime infrastructure; the chat pills
 * only list user-installed plugins), but a workspace `.disabled` sentinel
 * still excludes them. Omit `conversationId` (or pass a conversation with no
 * per-chat restriction) and every globally-enabled plugin's hooks run.
 */
export async function getHookEntriesFor<TCtx = unknown>(
  name: string,
  options?: { conversationId?: string },
): Promise<HookEntry<TCtx>[]> {
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
  return getUserHookEntriesFor<TCtx>(name, effectiveEnabledPlugins);
}

/**
 * {@link getHookEntriesFor} without owner attribution — returns just the hook
 * functions in the same order. Used by callers that only dispatch the chain
 * and don't attribute per-hook side effects.
 */
export async function getHooksFor<TCtx = unknown>(
  name: string,
  options?: { conversationId?: string },
): Promise<HookFunction<TCtx>[]> {
  const entries = await getHookEntriesFor<TCtx>(name, options);
  return entries.map((e) => e.fn);
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
