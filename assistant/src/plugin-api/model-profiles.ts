import { getConfig } from "../config/loader.js";
import { orderProfileKeys } from "../config/profile-order.js";
import type { ModelProfileInfo } from "./types.js";

/**
 * List the workspace inference profiles a plugin can route to, in the order the
 * `/model` picker presents them (`llm.profileOrder` first, then the rest
 * alphabetically). Mix profiles are omitted — they carry no model of their own
 * and are not a valid routing target; disabled profiles are included and
 * flagged via {@link ModelProfileInfo.isDisabled}.
 *
 * Reads the live in-memory config, so the result reflects the current profile
 * set each time it is called.
 */
export function getModelProfiles(): ModelProfileInfo[] {
  const { llm } = getConfig();
  const { profiles, activeProfile } = llm;
  const result: ModelProfileInfo[] = [];
  for (const key of orderProfileKeys(profiles, llm.profileOrder)) {
    const entry = profiles[key];
    if (entry == null || entry.mix != null) continue;
    result.push({
      key,
      label: entry.label ?? key,
      description: entry.description ?? null,
      isActive: key === activeProfile,
      isDisabled: entry.status === "disabled",
    });
  }
  return result;
}
