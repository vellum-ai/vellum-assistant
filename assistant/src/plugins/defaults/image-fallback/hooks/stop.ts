/**
 * Default `stop` hook: clears the per-conversation vision-recovery bound when
 * a turn terminates.
 *
 * The `post-model-call` hook (see `./post-model-call.ts`) marks the bound when
 * it captions raw image blocks after a vision-not-supported rejection and asks
 * the loop to retry. `stop` is the definitive terminal hook — it fires exactly
 * once when the turn is truly ending, after every retry decision has been made
 * — so clearing the bound here unconditionally guarantees the next turn always
 * recovers afresh, no matter how the turn ended (a finalized reply, an
 * unrecovered rejection, an abort, or a retry the loop's per-run backstop
 * refused).
 */

import type { HookFunction, StopContext } from "@vellumai/plugin-api";

import { clearVisionRecoveryAttempted } from "../src/recovery-state.js";

const stop: HookFunction<StopContext> = async (ctx) => {
  clearVisionRecoveryAttempted(ctx.conversationId);
};

export default stop;
