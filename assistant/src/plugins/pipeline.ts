/**
 * Plugin hook runner.
 *
 * A "hook" is a named lifecycle event (`user-prompt-submit`, `post-tool-use`,
 * ...) that every registered plugin may handle. The runner walks each plugin's
 * hook for a given event in registration order, threading a context value
 * through the chain so hooks can observe and transform it. A hook either
 * mutates the context in place (returning `void`) or returns a partial
 * context whose fields are merged onto the threaded value.
 *
 * Design doc: `.private/plans/agent-plugin-system.md`.
 */

import type { HookName } from "../plugin-api/constants.js";
import { getHooksForFromCache } from "./mtime-cache.js";
import { getHooksFor } from "./registry.js";

// ─── Hook runner ────────────────────────────────────────────────────────────

/**
 * Execute a hook chain: walk every registered plugin's hook for `name` in
 * registration order, threading `initialCtx` through each. Hooks may either
 * mutate the context in place (returning `void`) or return a partial context
 * whose fields are merged onto the threaded value — keys the hook returns
 * overwrite the running context, every other field is preserved. The final
 * context after the chain settles is returned.
 *
 * User plugins are pulled from the mtime cache (filesystem-as-truth); the
 * cache transparently rebuilds stale plugins on read. First-party default
 * plugins are read from the registry (they have no on-disk sources).
 *
 * @param name        The hook identifier — pick one from {@link HOOKS}.
 * @param initialCtx  Context the first hook receives.
 * @returns The final context after the chain settles. Same reference as
 *          `initialCtx` when no plugin registers `name`, and when every
 *          chained hook returns `void` (mutation-in-place style).
 */
export async function runHook<TCtx>(
  name: HookName,
  initialCtx: TCtx,
): Promise<TCtx> {
  // Pull user plugin hooks from the mtime cache (triggers a freshness check
  // via stat — sub-millisecond for a typical plugin set).
  const userHooks = await getHooksForFromCache<TCtx>(name);
  // First-party defaults still come from the registry.
  const defaultHooks = getHooksFor<TCtx>(name);
  const allHooks = [...defaultHooks, ...userHooks];

  let active = initialCtx;
  for (const hook of allHooks) {
    const result = await hook(active);
    if (result !== undefined) {
      active = { ...active, ...result };
    }
  }
  return active;
}
