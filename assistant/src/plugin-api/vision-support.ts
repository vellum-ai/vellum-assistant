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

import { getConfig } from "../config/loader.js";
import {
  resolveDispatchProfileEntry,
  resolveEntryCatalogModel,
} from "./profile-catalog-resolution.js";
import type { ModelProfileInfo } from "./types.js";

/**
 * Whether the given model or profile can process image input.
 *
 * `modelOrProfile` may be a concrete model id, a profile key, or a
 * {@link ModelProfileInfo}. A bare string is resolved as a model id first and,
 * failing that, as a profile key. For a concrete model id, pass the resolved
 * `provider` to read the provider-specific catalog entry — a model can support
 * vision under one provider and not another. `provider` is ignored for a
 * profile (a profile carries its own provider). Returns `false` when nothing
 * resolves.
 */
export function doesSupportVision(
  modelOrProfile: ModelProfileInfo | string,
  provider?: string,
): boolean {
  if (typeof modelOrProfile === "string") {
    // Concrete model id first, then fall back to treating it as a profile key.
    return (
      modelVision(modelOrProfile, provider) ??
      profileVision(modelOrProfile) ??
      false
    );
  }
  return profileVision(modelOrProfile.key) ?? false;
}

/**
 * Catalog vision flag for a concrete model id, or `undefined` when the catalog
 * doesn't know the model. When `provider` is given, the provider-specific
 * catalog entry decides; when it is omitted, or the provider doesn't offer this
 * model, the first catalog provider that offers the model wins. A routing
 * identity (e.g. `vellum`) resolves through the model's catalog owner.
 */
function modelVision(model: string, provider?: string): boolean | undefined {
  if (provider != null) {
    const scoped = resolveEntryCatalogModel({ model, provider });
    if (scoped != null) {
      return scoped.supportsVision ?? false;
    }
    // Provider unknown or doesn't offer this model — fall back to the
    // model-id-only catalog match below.
  }
  const catalogModel = resolveEntryCatalogModel({ model });
  return catalogModel != null
    ? (catalogModel.supportsVision ?? false)
    : undefined;
}

/**
 * Resolve a profile key to its vision capability, or `undefined` when the key
 * is unknown or resolves to a model the catalog doesn't know. Resolution
 * follows the same `llm.defaultProvider`-aware path dispatch uses (see
 * {@link resolveDispatchProfileEntry}), so on a BYOK install a default profile
 * is capability-checked against the model it actually runs — the default
 * provider's column — not the managed `vellum` body. A mix profile resolves to
 * `true` if any arm supports vision (the mix can route to it) and `false` only
 * once every arm is a known text-only model.
 */
function profileVision(profileKey: string): boolean | undefined {
  const { llm } = getConfig();
  const entry = resolveDispatchProfileEntry(llm, profileKey);
  if (entry == null) {
    return undefined;
  }

  if (entry.mix != null) {
    let sawUnknown = false;
    for (const arm of entry.mix) {
      const armEntry = resolveDispatchProfileEntry(llm, arm.profile);
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
 * own `(provider, model)`. Returns `undefined` when the entry doesn't resolve
 * to a known catalog model — an entry that omits its model is not a usable
 * resolution target, so it fails safe to "caption".
 */
function resolveEntryVision(entry: {
  provider?: string;
  model?: string;
}): boolean | undefined {
  return resolveEntryCatalogModel(entry)?.supportsVision;
}
