/**
 * Default `user-prompt-submit` hook: normalizes the working message history so
 * it satisfies the provider's tool-use/tool-result pairing and role-alternation
 * rules before the agent loop hands it to the provider.
 *
 * Defaults register before any user plugin, so this hook runs at the front of
 * the `user-prompt-submit` chain — every later hook sees an already-normalized
 * history. The hook mutates `latestMessages` in place by reassigning it to the
 * repaired list.
 */

import type {
  PluginHookFn,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import { repairHistory } from "../terminal.js";

const userPromptSubmit: PluginHookFn<UserPromptSubmitContext> = async (ctx) => {
  const { messages, stats } = repairHistory(ctx.latestMessages);
  ctx.latestMessages = messages;
  if (
    stats.assistantToolResultsMigrated > 0 ||
    stats.missingToolResultsInserted > 0 ||
    stats.orphanToolResultsDowngraded > 0 ||
    stats.consecutiveSameRoleMerged > 0
  ) {
    ctx.logger.warn(
      { plugin: "history-repair", phase: "pre_run", ...stats },
      "Repaired runtime history before provider call",
    );
  }
};

export default userPromptSubmit;
