/**
 * `post-model-call` hook for the advisor plugin.
 *
 * Snapshots the transcript the executor just saw. This fires after the model
 * returns its message (which may carry the `advisor` tool_use) but before the
 * tools run, so when `advisor.execute()` runs an instant later it reads exactly
 * this snapshot — the analogue of the platform forwarding the full transcript.
 *
 * Pure observer: it never mutates `content` or the continue/stop `decision`.
 * Gated to the user-facing reply so background/subagent/compaction calls — and
 * the advisor's own `advisor`-call-site sub-inference — are ignored.
 */

import type { PluginHookFn, PostModelCallContext } from "@vellumai/plugin-api";

import { recordMessages } from "../advisor-state-store.js";

const postModelCall: PluginHookFn<PostModelCallContext> = async (ctx) => {
  if (ctx.callSite !== "mainAgent") return;
  if (ctx.error) return;
  recordMessages(ctx.conversationId, ctx.messages);
};

export default postModelCall;
