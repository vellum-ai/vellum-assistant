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
 * flag resets at the turn boundary so a later turn repairs independently.
 *
 * Only error stops are handled; a successful stop (the model returned a
 * response) is left untouched for the empty-response plugin.
 */

import type { PluginHookFn, StopContext } from "@vellumai/plugin-api";

import { getRepairState } from "../repair-state-store.js";
import { deepRepairHistory, isRepairableOrderingError } from "../terminal.js";

const stop: PluginHookFn<StopContext> = async (ctx) => {
  if (!ctx.error || !isRepairableOrderingError(ctx.error.message)) return;

  const state = getRepairState(ctx.conversationId);
  if (state.orderingRepairAttempted) return;
  state.orderingRepairAttempted = true;

  ctx.messages = deepRepairHistory(ctx.messages).messages;
  ctx.decision = "continue";
  ctx.logger.warn(
    { plugin: "history-repair", messageCount: ctx.messages.length },
    "Provider ordering error — recovering via history deep-repair",
  );
};

export default stop;
