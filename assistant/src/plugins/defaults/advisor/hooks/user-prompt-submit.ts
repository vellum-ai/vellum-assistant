/**
 * `user-prompt-submit` hook: seed the per-conversation capture at the start of a
 * user turn with the inbound history, so an advisor call on the very first model
 * turn still has context even before `post-model-call` snapshots the running
 * transcript.
 */

import type {
  PluginHookFn,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import { seedCapture } from "../advisor-state-store.js";

const userPromptSubmit: PluginHookFn<UserPromptSubmitContext> = async (ctx) => {
  seedCapture(ctx.conversationId, ctx.latestMessages);
};

export default userPromptSubmit;
