/**
 * Per-chat-profile gate for the advisor.
 *
 * The advisor is active or not depending on the chat profile the turn routes
 * to (`ProfileEntry.advisorEnabled`). Default-on: the advisor runs unless a
 * profile sets `advisorEnabled: false` explicitly — absent/null both mean on,
 * preserving the prior always-on behavior for profiles that never set it.
 */

import { resolveDefaultProfileKey } from "../../../config/llm-resolver.js";
import { getConfig } from "../../../config/loader.js";

/**
 * Whether the advisor is enabled for the chat profile this turn uses.
 *
 * `modelProfile` is the call's already-resolved profile — `PreModelCallContext.modelProfile`
 * from the steering hook, or `ToolContext.overrideProfile` from the tool. Pass
 * `null` when no per-turn override applies, in which case the workspace active
 * profile — or the `mainAgent` call-site default — applies.
 */
export function advisorEnabledForProfile(modelProfile: string | null): boolean {
  const { llm } = getConfig();
  const key =
    modelProfile ??
    llm.activeProfile ??
    resolveDefaultProfileKey("mainAgent", llm);
  const entry = key ? llm.profiles[key] : undefined;
  return entry?.advisorEnabled !== false;
}
