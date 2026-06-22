/**
 * `pre-model-call` hook: for the user-facing reply (`mainAgent`), capture the
 * executor's system prompt (steering stripped) so the advisor can be given it
 * as context, and inject the advisor steering so the model reaches for the
 * tool. Idempotent via the steering marker.
 */

import type { PluginHookFn, PreModelCallContext } from "@vellumai/plugin-api";

import { advisorEnabledForProfile } from "../advisor-gate.js";
import { recordSystemPrompt } from "../advisor-state-store.js";
import { ADVISOR_CONFIG } from "../config.js";
import { appendSteering, stripSteering } from "../steering.js";

const preModelCall: PluginHookFn<PreModelCallContext> = async (ctx) => {
  if (ctx.callSite !== "mainAgent") return;

  recordSystemPrompt(ctx.conversationId, stripSteering(ctx.systemPrompt));

  // Steer the model to consult only when the steering is globally on AND the
  // chat profile this turn routes to has the advisor enabled (default on).
  if (
    ADVISOR_CONFIG.steeringEnabled &&
    advisorEnabledForProfile(ctx.modelProfile)
  ) {
    ctx.systemPrompt = appendSteering(ctx.systemPrompt);
  }
};

export default preModelCall;
