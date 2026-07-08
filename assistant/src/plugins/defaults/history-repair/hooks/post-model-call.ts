/**
 * Default `post-model-call` hook: recovers from a provider ordering rejection.
 *
 * A provider rejects the call when the history violates tool-use/tool-result
 * pairing or role-alternation rules (orphan `tool_use`, orphan
 * `web_search_tool_result`, leading assistant turn, consecutive same-role
 * turns). That rejection is a model-call outcome — the loop runs the
 * `post-model-call` chain with the rejection attached. This hook recognizes the
 * ordering class and runs {@link deepRepairHistory} directly — deliberately not
 * through the `user-prompt-submit` hook chain, whose user/plugin hooks may have
 * caused the drift — to re-normalize the history, then asks the loop to retry
 * the call.
 *
 * Bounded to one pass per turn via the per-conversation repair state: a second
 * consecutive ordering rejection means the repair could not recover the
 * history, so the hook leaves the error to surface rather than looping. The
 * loop's per-run backstop caps these retries globally; this one-shot mark keeps
 * a single recovery attempt per turn. This hook only ever marks the
 * conversation; the sibling `stop` hook (see `./stop.ts`) clears the mark when
 * the turn terminates, so the next turn always repairs afresh.
 *
 * A finalized reply (the model returned content) is left untouched for the
 * empty-response hook; only a provider rejection is this hook's to act on.
 */

import type { HookFunction, PostModelCallContext } from "@vellumai/plugin-api";

import {
  isOrderingRepairAttempted,
  markOrderingRepairAttempted,
} from "../repair-state-store.js";
import { deepRepairHistory, isRepairableOrderingError } from "../terminal.js";

const postModelCall: HookFunction<PostModelCallContext> = async (ctx) => {
  if (
    ctx.error &&
    isRepairableOrderingError(ctx.error.message) &&
    !isOrderingRepairAttempted(ctx.conversationId)
  ) {
    markOrderingRepairAttempted(ctx.conversationId);
    ctx.messages = deepRepairHistory(ctx.messages).messages;
    ctx.decision = "continue";
    ctx.logger.warn(
      { plugin: "history-repair", messageCount: ctx.messages.length },
      "Provider ordering error — recovering via history deep-repair",
    );
  }
};

export default postModelCall;
