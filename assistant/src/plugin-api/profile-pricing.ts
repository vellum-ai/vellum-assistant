/**
 * Input-token pricing for a workspace inference profile.
 *
 * A plugin that must choose among several routing-eligible profiles by cost
 * (e.g. picking the cheapest vision-capable profile for image captioning) reads
 * the resolved model's input-token rate through {@link getProfileInputTokenPrice}
 * instead of hardcoding model names or prices.
 */

import { getEffectiveProfile } from "../config/default-profile-catalog.js";
import { getConfig } from "../config/loader.js";
import { resolveEntryCatalogModel } from "./profile-catalog-resolution.js";
import type { ModelProfileInfo } from "./types.js";

/**
 * The catalog input-token price (USD per 1M tokens) of the model a profile
 * resolves to, or `null` when the price is unknown.
 *
 * A `string` argument is a profile key; a {@link ModelProfileInfo} is read for
 * its `key`. `null` covers a profile that doesn't resolve to a catalog model, a
 * catalog model that carries no pricing, and a "mix" profile — a mix has no
 * single `(provider, model)`, so its per-call price is indeterminate. Callers
 * ranking profiles by cost treat `null` as "rank last".
 */
export function getProfileInputTokenPrice(
  profile: ModelProfileInfo | string,
): number | null {
  const key = typeof profile === "string" ? profile : profile.key;
  const { llm } = getConfig();
  const entry = getEffectiveProfile(llm.profiles, key);
  if (entry == null || entry.mix != null) {
    return null;
  }
  return resolveEntryCatalogModel(entry)?.pricing?.inputPer1mTokens ?? null;
}
