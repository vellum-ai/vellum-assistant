/**
 * `post-model-call` hook: snapshot the transcript the executor just saw. Fires
 * after the model returns its message (which may carry the `advisor` tool_use)
 * but before tools run, so when `advisor.execute()` runs an instant later it
 * reads exactly this snapshot.
 *
 * Pure observer: never mutates `content` or the continue/stop `decision`. Gated
 * to the user-facing reply, so background/subagent/compaction calls — and the
 * advisor's own `inference`-call-site sub-call — are ignored.
 */

import type { PluginHookFn, PostModelCallContext } from "@vellumai/plugin-api";

import { recordMessages } from "../advisor-state-store.js";

const postModelCall: PluginHookFn<PostModelCallContext> = async (ctx) => {
  if (ctx.callSite !== "mainAgent") return;
  if (ctx.error) return;
  recordMessages(ctx.conversationId, ctx.messages);
};

export default postModelCall;
