/**
 * Default `stop` hook: clears the per-conversation max-tokens auto-continue
 * budget when a turn terminates.
 *
 * The `post-model-call` hook (see `./post-model-call.ts`) consumes budget each
 * time it resumes a truncated turn. `stop` is the definitive terminal hook —
 * it fires exactly once when the turn is truly ending — so clearing the
 * counter here unconditionally guarantees the next run starts with a full
 * budget, no matter how the turn ended.
 */

import type { HookFunction, StopContext } from "@vellumai/plugin-api";

import { clearMaxTokensContinueBudget } from "../continue-state-store.js";

const stop: HookFunction<StopContext> = async (ctx) => {
  clearMaxTokensContinueBudget(ctx.conversationId);
};

export default stop;
