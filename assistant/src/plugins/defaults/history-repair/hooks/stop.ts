/**
 * Default `stop` hook: clears the per-conversation ordering-repair bound when a
 * turn terminates.
 *
 * The `post-model-call` hook (see `./post-model-call.ts`) marks the bound when
 * it deep-repairs the history and asks the loop to retry. `stop` is the
 * definitive terminal hook — it fires exactly once when the turn is truly
 * ending, after every retry decision has been made — so clearing the bound here
 * unconditionally guarantees the next turn always repairs afresh, no matter how
 * the turn ended (a finalized reply, an unrecovered rejection, an abort, or a
 * retry the loop's per-run backstop refused).
 */

import type { PluginHookFn, StopContext } from "@vellumai/plugin-api";

import { clearOrderingRepairAttempted } from "../repair-state-store.js";

const stop: PluginHookFn<StopContext> = async (ctx) => {
  clearOrderingRepairAttempted(ctx.conversationId);
};

export default stop;
