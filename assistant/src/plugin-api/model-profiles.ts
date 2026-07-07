import { getEffectiveProfiles } from "../config/default-profile-catalog.js";
import { getConfig } from "../config/loader.js";
import { isDispatchableProfile } from "../config/profile-dispatchability.js";
import { orderProfileKeys } from "../config/profile-order.js";
import type { ModelProfileInfo } from "./types.js";

/**
 * List the workspace inference profiles a plugin can route to, in the order the
 * `/model` picker presents them (`llm.profileOrder` first, then the rest
 * alphabetically). Metadata-only entries without a provider, model, or mix are
 * not routing targets, so plugins never see them. Disabled profiles are
 * included and flagged via
 * {@link ModelProfileInfo.isDisabled}; weighted "mix" profiles are included and
 * flagged via {@link ModelProfileInfo.isMix}, since a mix is itself a valid
 * routing target (it resolves to one constituent per conversation).
 *
 * Reads the live in-memory config, so the result reflects the current profile
 * set each time it is called.
 */
export function getModelProfiles(): ModelProfileInfo[] {
  const { llm } = getConfig();
  const { activeProfile } = llm;
  const profiles = getEffectiveProfiles(llm.profiles);
  const result: ModelProfileInfo[] = [];
  for (const key of orderProfileKeys(profiles, llm.profileOrder)) {
    const entry = profiles[key];
    if (entry == null) continue;
    if (!isDispatchableProfile(entry)) continue;
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
