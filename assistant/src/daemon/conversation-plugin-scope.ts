/**
 * Resolve a conversation's effective plugin scope for the hook pipeline.
 *
 * The hook pipeline calls this by `conversationId` so lifecycle hooks honor
 * the per-chat plugin selection. Resolution is memory-then-DB: prefer the live
 * conversation/subagent (so a mid-conversation selection change applies to the
 * next turn's hooks), falling back to the persisted `enabled_plugins` row when
 * no live instance is resident. `null` means no per-chat restriction — every
 * globally-enabled plugin's hooks run.
 */

import { getConversationEnabledPlugins } from "../persistence/conversation-crud.js";
import { getLogger } from "../util/logger.js";
import { findConversationOrSubagent } from "./conversation-registry.js";
import { getEffectiveEnabledPluginSet } from "./conversation-tool-setup.js";

const log = getLogger("conversation-plugin-scope");

/** Resolve `conversationId`'s effective plugin scope; `null` = no restriction. */
export function resolveConversationPluginScope(
  conversationId: string,
): Set<string> | null {
  const live = findConversationOrSubagent(conversationId);
  if (live) return getEffectiveEnabledPluginSet(live);
  // Fall back to the persisted row for a non-resident conversation. A failure
  // here must not break hook discovery — fail open to no restriction so the
  // turn's hooks still run, rather than dropping every plugin's lifecycle hook.
  try {
    const enabledPlugins = getConversationEnabledPlugins(conversationId);
    return getEffectiveEnabledPluginSet({ enabledPlugins });
  } catch (err) {
    log.debug(
      { err, conversationId },
      "Failed to resolve per-chat plugin scope from DB; applying no restriction",
    );
    return null;
  }
}
