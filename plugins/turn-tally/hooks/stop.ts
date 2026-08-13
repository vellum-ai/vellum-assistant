/**
 * `stop` hook: records how the turn ended on the conversation's tally.
 * Fires exactly once per run at every terminal exit, which makes it the
 * right boundary for a per-turn closing write (nothing re-enters the loop
 * this run).
 */

import type { HookFunction, StopContext } from "@vellumai/plugin-api";

import { recordExit } from "../src/tally-store.js";

const stop: HookFunction<StopContext> = async (ctx) => {
  recordExit(ctx.conversationId, ctx.exitReason);
};

export default stop;
