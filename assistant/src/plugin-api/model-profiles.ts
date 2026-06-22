import { AUTO_PROFILE_KEY } from "../api/constants/inference-profiles.js";
import { getConfig } from "../config/loader.js";
import { orderProfileKeys } from "../config/profile-order.js";
import type { ModelProfileInfo } from "./types.js";

/**
 * List the workspace inference profiles a plugin can route to, in the order the
 * `/model` picker presents them (`llm.profileOrder` first, then the rest
 * alphabetically). Disabled profiles are included and flagged via
 * {@link ModelProfileInfo.isDisabled}; weighted "mix" profiles are included and
 * flagged via {@link ModelProfileInfo.isMix}, since a mix is itself a valid
 * routing target (it resolves to one constituent per conversation).
 *
 * The meta-"auto" profile is excluded — it has no concrete provider/model and
 * cannot be used as a dispatch target by a plugin sending an actual LLM call.
 *
 * Reads the live in-memory config, so the result reflects the current profile
 * set each time it is called.
 */
export function getModelProfiles(): ModelProfileInfo[] {
  const { llm } = getConfig();
  const { profiles, activeProfile } = llm;
  const result: ModelProfileInfo[] = [];
  for (const key of orderProfileKeys(profiles, llm.profileOrder)) {
    if (key === AUTO_PROFILE_KEY) continue;
    const entry = profiles[key];
    if (entry == null) continue;
    result.push({
      key,
      label: entry.label ?? key,
      description: entry.description ?? null,
      isActive: key === activeProfile,
      isDisabled: entry.status === "disabled",
      isMix: entry.mix != null,
    });
  }
  return result;
}
