/**
 * Default `stop` hook: recovers from a provider ordering rejection.
 *
 * A provider rejects the call when the history violates tool-use/tool-result
 * pairing or role-alternation rules (orphan `tool_use`, orphan
 * `web_search_tool_result`, leading assistant turn, consecutive same-role
 * turns). That rejection is an error stop — the loop runs the `stop` chain with
 * the rejection attached. This hook recognizes the ordering class and runs
 * {@link deepRepairHistory} directly — deliberately not through the
 * `user-prompt-submit` hook chain, whose user/plugin hooks may have caused the
 * drift — to re-normalize the history, then asks the loop to retry the call.
 *
 * Bounded to one pass per turn via the per-conversation repair state: a second
 * consecutive ordering rejection means the repair could not recover the
 * history, so the hook leaves the error to surface rather than looping. The
 * hook owns that state — it marks the conversation when it retries and clears
 * the mark on any terminal stop (a successful response, a non-ordering
 * rejection, or the exhausted second ordering rejection), so the next turn
 * repairs afresh without the loop or wrapper resetting anything.
 *
 * A successful stop (the model returned a response) is otherwise left untouched
 * for the empty-response plugin.
 */

import type { PluginHookFn, StopContext } from "@vellumai/plugin-api";

import {
  clearOrderingRepairAttempted,
  isOrderingRepairAttempted,
  markOrderingRepairAttempted,
} from "../repair-state-store.js";
import { deepRepairHistory, isRepairableOrderingError } from "../terminal.js";

const stop: PluginHookFn<StopContext> = async (ctx) => {
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

  // A terminal stop — a successful response or an unrecovered rejection — ends
  // the turn, so clear the bound the next turn starts from. A `"continue"`
  // decision means an earlier hook is already retrying this turn; the bound
  // must survive that retry so a later ordering rejection in the same turn is
  // recognized as this hook's exhausted second attempt rather than a fresh
  // first one. The error stop retry has no loop-side cap, so dropping the bound
  // mid-turn could let alternating recoverable rejections reissue the provider
  // call indefinitely.
  if (ctx.decision === "stop") {
    clearOrderingRepairAttempted(ctx.conversationId);
  }
};

export default stop;
