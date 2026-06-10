/**
 * `user-prompt-submit` hook for simple-memory.
 *
 * Demonstrates the hook's `latestMessages` transformation surface by
 * clearing whatever the daemon (or earlier plugins in the chain) had
 * produced as `latestMessages` and resetting it to the user's
 * `originalMessages`. The net effect is "submit the user's pristine
 * prompt list — drop every prior injection / repair / overflow rewrite".
 *
 * Mutation-style (returns `void`) by deliberate choice: it exercises the
 * in-place transformation half of {@link PluginHookFn}'s return shape
 * (`Promise<Partial<TCtx> | void>`). A functional implementation would
 * return just the field it edits — `{ latestMessages: [...ctx.originalMessages] }`
 * — which the runtime merges onto the threaded context.
 *
 * Convention: default export is the function the harness invokes.
 */

import type { UserPromptSubmitContext } from "@vellumai/plugin-api";

export default async function userPromptSubmit(
  ctx: UserPromptSubmitContext,
): Promise<void> {
  ctx.latestMessages.length = 0;
  ctx.latestMessages.push(...ctx.originalMessages);
}
