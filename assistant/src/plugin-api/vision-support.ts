/**
 * Vision-support resolution for plugin consumption.
 *
 * A plugin that gates image processing on vision capability (e.g. an
 * image-to-text fallback for text-only models) calls {@link doesSupportVision}
 * instead of hardcoding model names. One entry point serves both shapes a
 * caller might hold:
 * - a concrete model id (e.g. the provider-reported model that just ran), and
 * - a profile — either a {@link ModelProfileInfo} or a bare profile key —
 *   resolved through `llm.profiles` to an effective `(provider, model)`.
 *
 * A bare string is tried as a model id first and then as a profile key, so the
 * two callers share one function. Resolution returns `false` when nothing
 * resolves (rather than failing open): a consumer gating an image→text
 * fallback wants an unknown model treated as "can't show images" — caption it —
 * over silently shipping a raw image to a provider that may reject it.
 */

import { getEffectiveProfile } from "../config/default-profile-catalog.js";
import { getConfig } from "../config/loader.js";
import {
  getCatalogProviderForModel,
  PROVIDER_CATALOG,
} from "../providers/model-catalog.js";
import type { ModelProfileInfo } from "./types.js";

/**
 * Whether the given model or profile can process image input.
 *
 * `modelOrProfile` may be a concrete model id, a profile key, or a
 * {@link ModelProfileInfo}. A bare string is resolved as a model id first and,
 * failing that, as a profile key. Returns `false` when nothing resolves.
 */
export function doesSupportVision(
  modelOrProfile: ModelProfileInfo | string,
): boolean {
  if (typeof modelOrProfile === "string") {
    // Concrete model id first, then fall back to treating it as a profile key.
    return (
      modelVision(modelOrProfile) ?? profileVision(modelOrProfile) ?? false
    );
  }
  return profileVision(modelOrProfile.key) ?? false;
}

/**
 * Catalog vision flag for a concrete model id, or `undefined` when the catalog
 * doesn't know the model. The same model id carries the same capability under
 * every provider that offers it, so the first catalog match wins.
 */
function modelVision(model: string): boolean | undefined {
  for (const provider of PROVIDER_CATALOG) {
    const catalogModel = provider.models.find((m) => m.id === model);
    if (catalogModel != null) return catalogModel.supportsVision ?? false;
  }
  return undefined;
}

/**
 * Resolve a profile key through `llm.profiles` to its vision capability, or
 * `undefined` when the key is unknown or resolves to a model the catalog
 * doesn't know. A mix profile resolves to `true` if any arm supports vision
 * (the mix can route to it) and `false` only once every arm is a known
 * text-only model.
 */
function profileVision(profileKey: string): boolean | undefined {
  const { llm } = getConfig();
  const entry = getEffectiveProfile(llm.profiles, profileKey);
  if (entry == null) return undefined;

  if (entry.mix != null) {
    let sawUnknown = false;
    for (const arm of entry.mix) {
      const armEntry = getEffectiveProfile(llm.profiles, arm.profile);
      const armVision =
        armEntry == null ? undefined : resolveEntryVision(armEntry, llm);
      if (armVision === true) return true;
      if (armVision == null) sawUnknown = true;
    }
    return sawUnknown ? undefined : false;
  }

  return resolveEntryVision(entry, llm);
}

/**
 * Resolve whether a concrete (non-mix) profile entry supports vision by
 * merging its fields over `llm.default` and inferring the provider when only
 * the model is set. Returns `undefined` when the effective `(provider, model)`
 * can't be determined or isn't in the catalog.
 */
function resolveEntryVision(
  entry: { provider?: string; model?: string },
  llm: { default?: { provider?: string; model?: string } },
): boolean | undefined {
  const provider = entry.provider ?? llm.default?.provider;
  const model = entry.model ?? llm.default?.model;

  // Infer provider from model when missing (mirrors the resolver's
  // withImpliedProviders).
  const effectiveProvider =
    provider ??
    (typeof model === "string" ? getCatalogProviderForModel(model) : undefined);

  if (typeof effectiveProvider !== "string" || typeof model !== "string") {
    return undefined;
  }

  const catalogProvider = PROVIDER_CATALOG.find(
    (p) => p.id === effectiveProvider,
  );
  const catalogModel = catalogProvider?.models.find((m) => m.id === model);
  return catalogModel?.supportsVision;
}
