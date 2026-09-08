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
 *   Default profile keys resolve through `llm.defaultProvider`'s column of the
 *   intent × provider matrix, so the judged model is the one that actually
 *   runs on a BYO install. A profile whose provider names a connection entry
 *   row (e.g. a `<vendor>-personal` binding) is judged by the row's
 *   dispatchable vendor, sharing dispatch's entry-name translation.
 *
 * A bare string is tried as a model id first and then as a profile key, so the
 * two callers share one function. Resolution returns `false` when nothing
 * resolves (rather than failing open): a consumer gating an image→text
 * fallback wants an unknown model treated as "can't show images" — caption it —
 * over silently shipping a raw image to a provider that may reject it.
 */

import { resolveDefaultProfileForProvider } from "../config/default-profile-catalog.js";
import {
  catalogEntryFor,
  type InputModalities,
  modalitiesOf,
  resolveModalityOverride,
} from "../config/input-modalities.js";
import { getConfig } from "../config/loader.js";
import { resolveEntryProviderKind } from "../providers/connection-resolution.js";
import { ROUTING_IDENTITY_PROVIDERS } from "../providers/inference/auth.js";
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
    // Concrete catalog model id first, then a profile key, then any profile
    // bound to that model id (so a free-text override is visible to callers
    // that only have the provider-reported model, e.g. post-tool-use).
    return (
      modelVision(modelOrProfile) ??
      profileVision(modelOrProfile) ??
      modelVisionFromBoundProfiles(modelOrProfile) ??
      false
    );
  }
  return profileVision(modelOrProfile.key) ?? false;
}

/**
 * Vision from a profile whose `model` field matches `model`. Used when the
 * catalog does not know the id (openai-compatible / free-text). Any bound
 * profile that declares image support wins so tool-result images are not
 * captioned for a model the user marked as vision-capable.
 */
function modelVisionFromBoundProfiles(model: string): boolean | undefined {
  const profiles = getConfig().llm.profiles ?? {};
  let sawUnknown = false;
  let sawFalse = false;
  for (const entry of Object.values(profiles)) {
    if (entry?.model !== model || entry.mix != null) {
      continue;
    }
    const vision = resolveEntryVision(entry);
    if (vision === true) {
      return true;
    }
    if (vision === false) {
      sawFalse = true;
    } else {
      sawUnknown = true;
    }
  }
  if (sawUnknown) {
    return undefined;
  }
  if (sawFalse) {
    return false;
  }
  return undefined;
}

/**
 * Catalog vision flag for a concrete model id, or `undefined` when the catalog
 * doesn't know the model. The same model id carries the same capability under
 * every provider that offers it, so the first catalog match wins.
 */
function modelVision(model: string): boolean | undefined {
  for (const provider of PROVIDER_CATALOG) {
    const catalogModel = provider.models.find((m) => m.id === model);
    if (catalogModel != null) {
      return catalogModel.supportsVision ?? false;
    }
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
  const defaultProvider = llm.defaultProvider ?? null;
  const entry = resolveDefaultProfileForProvider(
    llm.profiles,
    profileKey,
    defaultProvider,
  );
  if (entry == null) {
    return undefined;
  }

  if (entry.mix != null) {
    let sawUnknown = false;
    for (const arm of entry.mix) {
      const armEntry = resolveDefaultProfileForProvider(
        llm.profiles,
        arm.profile,
        defaultProvider,
      );
      const armVision =
        armEntry == null ? undefined : resolveEntryVision(armEntry);
      if (armVision === true) {
        return true;
      }
      if (armVision == null) {
        sawUnknown = true;
      }
    }
    return sawUnknown ? undefined : false;
  }

  return resolveEntryVision(entry);
}

/**
 * Resolve whether a concrete (non-mix) profile entry supports vision from its
 * own `(provider, model)`, inferring the provider from the catalog when only
 * the model is set. A profile `inputModalities.image` override wins over the
 * catalog. Returns `undefined` when the effective `(provider, model)` can't
 * be determined or isn't in the catalog and no override is set — an entry
 * that omits its model is not a usable resolution target, so it fails safe
 * to "caption".
 */
function resolveEntryVision(entry: {
  provider?: string;
  model?: string;
  inputModalities?: InputModalities | null;
}): boolean | undefined {
  // Routing identities ("vellum"/"chatgpt") are not catalog providers; the
  // model's catalog owner is the capability source for them.
  const declared =
    entry.provider != null && ROUTING_IDENTITY_PROVIDERS.has(entry.provider)
      ? undefined
      : entry.provider;
  const model = entry.model;

  // A provider naming a connection entry row (e.g. a "<vendor>-personal"
  // binding) translates to the row's dispatchable kind, the same translation
  // dispatch uses, so the catalog judges the vendor actually serving the
  // profile. Vendor ids pass through untranslated.
  const provider =
    declared != null
      ? (resolveEntryProviderKind(declared, model) ?? declared)
      : undefined;

  // Infer provider from model when missing (mirrors the resolver's catalog
  // provider implication).
  const effectiveProvider =
    provider ??
    (typeof model === "string" ? getCatalogProviderForModel(model) : undefined);

  if (typeof effectiveProvider !== "string" || typeof model !== "string") {
    return resolveModalityOverride(modalitiesOf(entry)?.image, undefined);
  }

  const catalogModel = catalogEntryFor(effectiveProvider, model);
  return resolveModalityOverride(
    modalitiesOf(entry)?.image,
    catalogModel?.supportsVision,
  );
}
