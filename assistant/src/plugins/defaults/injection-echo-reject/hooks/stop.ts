/**
 * Default `stop` hook: clears the per-conversation injection-echo reject bound
 * when a turn terminates.
 *
 * The `post-model-call` hook (see `./post-model-call.ts`) marks the bound when
 * it re-queries the model after rejecting a reserved-envelope completion.
 * `stop` is the definitive terminal hook, so clearing the bound here
 * unconditionally guarantees the next run rejects afresh, no matter how the
 * turn ended.
 */

import type { HookFunction, StopContext } from "@vellumai/plugin-api";

import { clearInjectionEchoRejected } from "../reject-state-store.js";

const stop: HookFunction<StopContext> = async (ctx) => {
  clearInjectionEchoRejected(ctx.conversationId);
};

export default stop;
