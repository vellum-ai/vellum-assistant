/**
 * `pre-model-call` hook for the advisor plugin.
 *
 * Two jobs, only for the user-facing reply (`mainAgent`):
 *  1. Capture the executor's system prompt (steering stripped) so the advisor
 *     can be given it as context.
 *  2. Inject the advisor steering block so the model reaches for the tool at
 *     the right times. Idempotent via the steering marker.
 */

import type { PluginHookFn, PreModelCallContext } from "@vellumai/plugin-api";

import { recordSystemPrompt } from "../advisor-state-store.js";
import { ADVISOR_CONFIG } from "../config.js";
import { appendSteering, stripSteering } from "../steering.js";

const preModelCall: PluginHookFn<PreModelCallContext> = async (ctx) => {
  if (ctx.callSite !== "mainAgent") return;

  // Record the original prompt (without our steering) for the advisor's view.
  recordSystemPrompt(ctx.conversationId, stripSteering(ctx.systemPrompt));

  if (ADVISOR_CONFIG.steeringEnabled) {
    ctx.systemPrompt = appendSteering(ctx.systemPrompt);
  }
};

export default preModelCall;
