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

import type { HookFunction, PostModelCallContext } from "@vellumai/plugin-api";

import { recordMessages } from "../advisor-state-store.js";

const postModelCall: HookFunction<PostModelCallContext> = async (ctx) => {
  if (ctx.callSite !== "mainAgent") return;
  if (ctx.error) return;
  // `ctx.messages` is the pre-reply history; the turn the model just produced —
  // including any text/plan it wrote before the `advisor` tool_use — lives in
  // `ctx.content` and is not yet in `messages`. Append it (cloned) so the
  // advisor reviews the full current transcript, not just the prior history.
  // `transcript.ts` strips the pending tool_use from this final assistant turn.
  const messages =
    ctx.content.length > 0
      ? [
          ...ctx.messages,
          { role: "assistant" as const, content: [...ctx.content] },
        ]
      : ctx.messages;
  recordMessages(ctx.conversationId, messages);
};

export default postModelCall;
