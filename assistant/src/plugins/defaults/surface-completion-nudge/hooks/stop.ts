/**
 * Default `stop` hook: clears the per-conversation surface-completion nudge
 * bound when a turn terminates.
 *
 * The `post-model-call` hook (see `./post-model-call.ts`) marks the bound when
 * it nudges the model to close a dangling progress surface. `stop` is the
 * definitive terminal hook — it fires exactly once when the turn is truly
 * ending, after every retry decision has been made — so clearing the bound here
 * unconditionally guarantees the next run nudges afresh, no matter how the turn
 * ended (a finalized reply, an abort, or a retry the loop's per-run backstop
 * refused).
 */

import type { HookFunction, StopContext } from "@vellumai/plugin-api";

import { clearSurfaceCompletionNudged } from "../nudge-state-store.js";

const stop: HookFunction<StopContext> = async (ctx) => {
  clearSurfaceCompletionNudged(ctx.conversationId);
};

export default stop;
