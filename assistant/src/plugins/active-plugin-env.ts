/**
 * Inject the owning plugin name into a sanitized child environment when
 * exactly one plugin-resident skill is active in the conversation.
 *
 * Identity comes from the skill catalog `owner` (install-directory
 * basename), not from the child command or package.json `name`.
 */

import { loadSkillCatalog } from "../config/skills.js";
import { findConversationOrSubagent } from "../daemon/conversation-registry.js";
import { PLUGIN_NAME_ENV } from "../plugin-api/plugin-name-env.js";

/**
 * Unique catalog owner id among plugin-resident skills active in this
 * conversation, or undefined when none or more than one plugin is active.
 */
export function uniqueActivePluginOwner(
  conversationId: string | undefined,
): string | undefined {
  if (conversationId === undefined || conversationId.length === 0) {
    return undefined;
  }
  const conversation = findConversationOrSubagent(conversationId);
  if (!conversation) {
    return undefined;
  }
  const owners = new Set<string>();
  const catalog = loadSkillCatalog();
  for (const skillId of conversation.skillProjectionState.keys()) {
    const skill = catalog.find((entry) => entry.id === skillId);
    if (skill?.owner?.kind === "plugin" && skill.owner.id.length > 0) {
      owners.add(skill.owner.id);
    }
  }
  if (owners.size !== 1) {
    return undefined;
  }
  return [...owners][0];
}

/** Set `VELLUM_PLUGIN_NAME` on `env` when a single plugin owner is active. */
export function applyActivePluginName(
  env: NodeJS.ProcessEnv,
  conversationId: string | undefined,
): void {
  const owner = uniqueActivePluginOwner(conversationId);
  if (owner === undefined) {
    return;
  }
  env[PLUGIN_NAME_ENV] = owner;
}
