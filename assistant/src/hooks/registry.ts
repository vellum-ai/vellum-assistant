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
 * default plugins register.
 *
 * {@link getHooksFor} combines both sources: in-process hooks from this
 * registry (filtered by `isPluginDisabled` at read time) and user-land hooks
 * from the plugin cache. The read-time filtering is what makes `assistant
 * plugins disable default-*` take effect immediately in a running assistant
 * — the hooks stay registered but are filtered out on the next turn.
 *
 * Reads are self-populating: a dispatch in a process that never ran plugin
 * bootstrap registers the defaults on its first read
 * ({@link ensureDefaultHooksRegistered}), so the sidecar workers that host
 * agent conversations run the same hook chain the daemon does without an
 * entry-point registration call. Registration only — `init` stays daemon-only.
 */

import { isPluginDisabled } from "../plugins/disabled-state.js";
import { getUserHookEntriesFor } from "../plugins/mtime-cache.js";
import type { HookEntry, HookFunction } from "../plugins/types.js";
import { getLogger } from "../util/logger.js";

// ─── Internal state ──────────────────────────────────────────────────────────

/**
 * Hook registry keyed by hook name. Each value is an ordered list of
 * `{fn, pluginName}` entries in registration order.
 */
const hookRegistry = new Map<
  string,
  Array<{ fn: HookFunction; pluginName: string }>
>();

/**
 * Whether anything has registered hooks into this process's registry. Set by
 * {@link registerPluginHooks}, so it is true as soon as a real bootstrap (or a
 * test fixture) has claimed ownership — see
 * {@link ensureDefaultHooksRegistered}.
 */
let hasRegisteredHooks = false;

/**
 * Memoized lazy registration of the first-party defaults — see
 * {@link ensureDefaultHooksRegistered}. `null` until the first read asks for
 * it; afterwards the settled promise is returned without repeating the work.
 */
let defaultRegistrationPromise: Promise<void> | null = null;

/**
 * Populate the registry with the first-party defaults when nothing else has.
 *
 * The rule is "whoever registered first owns the registry". A process that
 * runs plugin bootstrap (the daemon, via `initializePlugins()`) has already
 * registered the defaults before it ever dispatches, so this is a no-op there.
 * A process that does NOT run bootstrap gets them here, on its first dispatch:
 * the memory jobs worker and the schedule worker both host real agent
 * conversations, and those turns run the same `agent/loop.ts` hook chain, so
 * without this their dispatches resolve against an empty registry and silently
 * skip every default.
 *
 * Gating on {@link hasRegisteredHooks} rather than populating unconditionally
 * is what keeps the registry controllable: a caller that has deliberately
 * registered a specific set (every hook test that drives `runHook` over one
 * fixture plugin) still sees exactly that set, instead of having eighteen
 * defaults appear underneath it.
 *
 * Registration is NOT activation. This only inserts each default's hook
 * functions into the map; it never runs `init`, which must stay confined to
 * the daemon (see `plugins/mtime-cache.ts`). Running `init` here would be
 * actively harmful — `default-memory`'s `init` calls `runMemoryStartup`, which
 * starts the memory jobs worker, so the memory worker would try to spawn a
 * memory worker from inside itself.
 *
 * Imported dynamically so the default plugins' implementation graph stays out
 * of this module's static imports, and out of module evaluation — this runs at
 * hook-dispatch, well after boot, and the module cache makes repeat calls free.
 *
 * Never rejects. A failure here must not take down the turn that happened to
 * be the first dispatcher, so it is logged and the latch is cleared for a
 * later retry; that dispatch proceeds with whatever is registered.
 */
function ensureDefaultHooksRegistered(): Promise<void> {
  if (hasRegisteredHooks) {
    return Promise.resolve();
  }
  if (defaultRegistrationPromise === null) {
    defaultRegistrationPromise = (async () => {
      const { registerDefaultPlugins } =
        await import("../plugins/defaults/index.js");
      registerDefaultPlugins();
    })().catch((err: unknown) => {
      defaultRegistrationPromise = null;
      getLogger("hook-registry").error(
        { err },
        "Failed to register default plugin hooks; dispatch continues without them",
      );
    });
  }
  return defaultRegistrationPromise;
}

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
    // Someone is populating the registry explicitly, so the lazy default
    // registration must stand down — see `ensureDefaultHooksRegistered`.
    hasRegisteredHooks = true;
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
 * {@link isPluginDisabled}. User-land hooks are pulled from the plugin cache
 * (async, pure cache read). Default hooks are prepended so they compose
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
export async function getHookEntriesFor<TCtx = unknown>(
  name: string,
  options?: { conversationId?: string },
): Promise<HookEntry<TCtx>[]> {
  // Make sure the defaults are in the map before reading it. In the daemon
  // they already are (boot registered them); in a sidecar worker this first
  // read is what puts them there. Registration only — never activation.
  await ensureDefaultHooksRegistered();
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
  const defaultEntries: HookEntry<TCtx>[] = [];
  for (const entry of hookRegistry.get(name) ?? []) {
    if (isPluginDisabled(entry.pluginName)) {
      continue;
    }
    if (
      effectiveEnabledPlugins != null &&
      !effectiveEnabledPlugins.has(entry.pluginName)
    ) {
      continue;
    }
    defaultEntries.push({
      fn: entry.fn as HookFunction<TCtx>,
      owner: { kind: "plugin", id: entry.pluginName },
    });
  }

  // User-land hooks from the plugin cache (async, pure cache read; dispatch
  // never activates plugins). The per-chat
  // scope is threaded through so a deselected user plugin's hooks are excluded
  // too — standalone workspace hooks (not owned by a plugin) always run.
  const userEntries = await getUserHookEntriesFor<TCtx>(
    name,
    effectiveEnabledPlugins,
  );

  return [...defaultEntries, ...userEntries];
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
  // Drop the lazy-registration state too, so a reset genuinely returns the
  // process to "nobody owns this registry": a test that resets and dispatches
  // without registering anything gets the defaults, and one that resets and
  // registers its own fixtures keeps seeing only those.
  hasRegisteredHooks = false;
  defaultRegistrationPromise = null;
}
