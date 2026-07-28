/**
 * Default `stop` hook: clears the per-conversation empty-response nudge bound
 * when a turn terminates.
 *
 * The `post-model-call` hook (see `./post-model-call.ts`) marks the bound when
 * it re-queries the model after an empty turn. `stop` is the definitive
 * terminal hook — it fires exactly once when the turn is truly ending, after
 * every retry decision has been made — so clearing the bound here
 * unconditionally guarantees the next run nudges afresh, no matter how the turn
 * ended (a finalized reply, an abort, or a retry the loop's per-run backstop
 * refused).
 */

import type { HookFunction, StopContext } from "@vellumai/plugin-api";

import { clearEmptyResponseNudged } from "../nudge-state-store.js";

const stop: HookFunction<StopContext> = async (ctx) => {
  clearEmptyResponseNudged(ctx.conversationId);
};

export default stop;
