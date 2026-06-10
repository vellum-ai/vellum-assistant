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
 * a single recovery attempt per turn. This hook marks the conversation when it
 * retries and clears the mark on any outcome it resolves (a finalized reply, a
 * non-ordering rejection, or the exhausted second ordering rejection); the
 * sibling `stop` hook clears it on the one terminal this hook does not resolve
 * — a retry the loop's per-run backstop overrides — so the next turn always
 * repairs afresh.
 *
 * A finalized reply (the model returned content) is left untouched for the
 * empty-response hook; only a provider rejection is this hook's to act on.
 */

import type { PluginHookFn, PostModelCallContext } from "@vellumai/plugin-api";

import type { ContentBlock } from "../../../../providers/types.js";
import {
  clearOrderingRepairAttempted,
  isOrderingRepairAttempted,
  markOrderingRepairAttempted,
} from "../repair-state-store.js";
import { deepRepairHistory, isRepairableOrderingError } from "../terminal.js";

function hasToolUse(content: ReadonlyArray<ContentBlock>): boolean {
  return content.some((block) => block.type === "tool_use");
}

const postModelCall: PluginHookFn<PostModelCallContext> = async (ctx) => {
  if (ctx.error && isRepairableOrderingError(ctx.error.message)) {
    if (!isOrderingRepairAttempted(ctx.conversationId)) {
      markOrderingRepairAttempted(ctx.conversationId);
      ctx.messages = deepRepairHistory(ctx.messages).messages;
      ctx.decision = "continue";
      ctx.logger.warn(
        { plugin: "history-repair", messageCount: ctx.messages.length },
        "Provider ordering error — recovering via history deep-repair",
      );
      return;
    }
    // The repair already ran this turn and the call still rejected on ordering
    // grounds, so it could not recover. Clear the bound and let the error
    // surface rather than looping.
    clearOrderingRepairAttempted(ctx.conversationId);
    return;
  }

  // A tool-bearing turn continues mid-run — the loop runs the tools — so leave
  // the bound intact: a later ordering rejection this turn must still be
  // recognized as this hook's exhausted second attempt rather than a fresh
  // first one. (A provider rejection carries empty content, so this never fires
  // for one.)
  if (hasToolUse(ctx.content)) return;

  // A terminal outcome for this hook — a finalized no-tool reply or a
  // non-ordering rejection — ends the turn, so clear the bound the next turn
  // starts from. A `"continue"` decision means an earlier hook is already
  // retrying this turn; the bound must survive that retry so a later ordering
  // rejection in the same turn is recognized as this hook's exhausted second
  // attempt rather than a fresh first one.
  if (ctx.decision === "stop") {
    clearOrderingRepairAttempted(ctx.conversationId);
  }
};

export default postModelCall;
