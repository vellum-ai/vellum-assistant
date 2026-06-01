import type { LLMCallArgs, LLMCallResult, Middleware } from "../../../types.js";

/**
 * Passthrough middleware for the `llmCall` pipeline. Forwards to `next(args)`
 * unchanged so any user-registered middleware (registered later, inner in the
 * onion) still runs and the terminal at the call site (`agent/loop.ts`)
 * performs the actual `provider.sendMessage(...)` call.
 *
 * Defaults register at the OUTERMOST onion position; forwarding
 * unconditionally keeps user-registered middleware reachable.
 */
const defaultLlmCall: Middleware<LLMCallArgs, LLMCallResult> =
  async function defaultLlmCall(args, next, _ctx) {
    return next(args);
  };

export default defaultLlmCall;
