/**
 * `user-prompt-submit` hook: counts each real user prompt against the
 * conversation's tally and broadcasts the running total as a transient
 * `hook_event` for any UI watching the conversation.
 *
 * Observation-only: the hook never touches `latestMessages`, so the turn
 * the model sees is unchanged.
 */

import type {
  HookFunction,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import { recordPrompt } from "../src/tally-store.js";

const userPromptSubmit: HookFunction<UserPromptSubmitContext> = async (
  ctx,
) => {
  // Machine signals (e.g. wizard-close markers) are not user speech.
  if (ctx.isHiddenPrompt === true) {
    return;
  }
  const prompts = recordPrompt(ctx.conversationId);
  if (prompts !== null) {
    ctx.broadcast({ event: "prompt-recorded", prompts });
  }
};

export default userPromptSubmit;
