/**
 * Wire the daemon's resolution of a conversation's effective plugin scope into
 * the hook pipeline's dependency-injection seam.
 *
 * The hook pipeline (`plugins/pipeline.ts`) can't import daemon internals
 * without forming a `plugins/` → `daemon/` cycle, so it reads the scope through
 * the resolver registered here. Called once at plugin bootstrap.
 */

import { getConversationEnabledPlugins } from "../persistence/conversation-crud.js";
import { registerConversationPluginScopeResolver } from "../plugins/enabled-plugin-scope.js";
import { findConversationOrSubagent } from "./conversation-registry.js";
import { getEffectiveEnabledPluginSet } from "./conversation-tool-setup.js";

/**
 * Register the memory-then-DB resolver: prefer the live conversation/subagent
 * (so a mid-conversation selection change applies to the next turn's lifecycle
 * hooks), falling back to the persisted `enabled_plugins` row when no live
 * instance is resident. `null` (no per-chat restriction) propagates unchanged.
 */
export function registerConversationPluginScope(): void {
  registerConversationPluginScopeResolver((conversationId) => {
    const live = findConversationOrSubagent(conversationId);
    if (live) return getEffectiveEnabledPluginSet(live);
    const enabledPlugins = getConversationEnabledPlugins(conversationId);
    return getEffectiveEnabledPluginSet({ enabledPlugins });
  });
}
