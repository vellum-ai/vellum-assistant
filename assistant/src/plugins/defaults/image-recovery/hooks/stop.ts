/**
 * Default `stop` hook: clears the per-conversation image-recovery bound when a
 * turn terminates.
 *
 * The `post-model-call` hook (see `./post-model-call.ts`) marks the bound when
 * it downscales an oversized image and asks the loop to retry. `stop` is the
 * definitive terminal hook — it fires exactly once when the turn is truly
 * ending, after every retry decision has been made — so clearing the bound here
 * unconditionally guarantees the next turn always recovers afresh, no matter how
 * the turn ended (a finalized reply, an unrecovered rejection, an abort, or a
 * retry the loop's per-run backstop refused).
 */

import type { PluginHookFn, StopContext } from "@vellumai/plugin-api";

import { clearImageRecoveryAttempted } from "../image-recovery-state-store.js";

const stop: PluginHookFn<StopContext> = async (ctx) => {
  clearImageRecoveryAttempted(ctx.conversationId);
};

export default stop;
