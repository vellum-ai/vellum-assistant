import { getConfig } from "../config/loader.js";
import { orderProfileKeys } from "../config/profile-order.js";
import type { ModelProfileInfo } from "./types.js";

/**
 * Name of the meta-"auto" profile seeded by the daemon. The entry exists in
 * `llm.profiles` unconditionally so a switched-on `query-complexity-routing`
 * flag has something to point at, but it carries no provider/model of its own
 * — when selected, the daemon injects a `switch_inference_profile` tool and
 * the model self-selects a concrete profile per query. It is never a valid
 * concrete routing target for a plugin that needs to dispatch an actual LLM
 * call, so {@link getModelProfiles} excludes it.
 *
 * Mirrors `AUTO_PROFILE_KEY` in `assistant/src/config/seed-inference-profiles.ts`
 * and `AUTO_PROFILE_NAME` in `clients/web/src/assistant/profile-pickers.ts`.
 */
const AUTO_PROFILE_KEY = "auto";

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
