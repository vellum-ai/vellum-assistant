/**
 * Plugin hook runner.
 *
 * A "hook" is a named lifecycle event (`user-prompt-submit`, `post-tool-use`,
 * …) that every registered plugin may handle. The runner walks each plugin's
 * hook for a given event in registration order, threading a context value
 * through the chain so hooks can observe and transform it. A hook either
 * mutates the context in place (returning `void`) or returns a partial
 * context whose fields are merged onto the threaded value.
 *
 * Design doc: `.private/plans/agent-plugin-system.md`.
 */

import type { HookName } from "../plugin-api/constants.js";
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
  let active = initialCtx;
  for (const hook of getHooksFor<TCtx>(name)) {
    const result = await hook(active);
    if (result !== undefined) {
      active = { ...active, ...result };
    }
  }
  return active;
}
