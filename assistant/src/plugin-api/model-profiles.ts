import { getConfig } from "../config/loader.js";
import { orderProfileKeys } from "../config/profile-order.js";
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import type { ModelProfileInfo } from "./types.js";

/**
 * List the workspace inference profiles a plugin can route to, in the order the
 * `/model` picker presents them (`llm.profileOrder` first, then the rest
 * alphabetically). Disabled profiles are included and flagged via
 * {@link ModelProfileInfo.isDisabled}; weighted "mix" profiles are included and
 * flagged via {@link ModelProfileInfo.isMix}, since a mix is itself a valid
 * routing target (it resolves to one constituent per conversation).
 *
 * Each profile is annotated with {@link ModelProfileInfo.supportsVision},
 * resolved from the model catalog the same way the config GET route does it:
 * the matching `CatalogModel.supportsVision` flag, defaulting to `true`
 * (fail-open) when the (provider, model) pair is not in the catalog. A plugin
 * that needs to know whether the active profile can process images reads this
 * field instead of hardcoding model names.
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
    if (entry == null) continue;
    result.push({
      key,
      label: entry.label ?? key,
      description: entry.description ?? null,
      isActive: key === activeProfile,
      isDisabled: entry.status === "disabled",
      isMix: entry.mix != null,
      supportsVision: resolveSupportsVision(entry.provider, entry.model),
    });
  }
  return result;
}

/**
 * Resolve whether a profile's model can process images, using the model
 * catalog as the source of truth. Unknown (provider, model) pairs default
 * to `true` (fail-open) so custom / unlisted models are not silently
 * stripped of image input.
 */
function resolveSupportsVision(
  provider: string | undefined,
  model: string | undefined,
): boolean {
  if (typeof provider !== "string" || typeof model !== "string") return true;
  const catalogProvider = PROVIDER_CATALOG.find((p) => p.id === provider);
  const catalogModel = catalogProvider?.models.find((m) => m.id === model);
  return catalogModel?.supportsVision ?? true;
}
