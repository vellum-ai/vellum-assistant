/**
 * Resolve a workspace profile entry to its effective catalog model.
 *
 * Vision-capability and input-token pricing both need the concrete
 * {@link CatalogModel} a profile's `(provider, model)` resolves to, so the
 * resolution lives here once and each caller reads the field it needs off the
 * returned model.
 */

import { ROUTING_IDENTITY_PROVIDERS } from "../providers/inference/auth.js";
import {
  type CatalogModel,
  getCatalogProviderForModel,
  PROVIDER_CATALOG,
} from "../providers/model-catalog.js";

/**
 * Resolve a concrete (non-mix) profile entry to its catalog model from its own
 * `(provider, model)`, inferring the provider from the catalog when only the
 * model is set. Returns `undefined` when the effective `(provider, model)`
 * can't be determined or isn't in the catalog — an entry that omits its model
 * is not a usable resolution target.
 */
export function resolveEntryCatalogModel(entry: {
  provider?: string;
  model?: string;
}): CatalogModel | undefined {
  // Routing identities ("vellum"/"chatgpt") are not catalog providers; the
  // model's catalog owner is the capability source for them.
  const provider =
    entry.provider != null && ROUTING_IDENTITY_PROVIDERS.has(entry.provider)
      ? undefined
      : entry.provider;
  const model = entry.model;

  // Infer provider from model when missing (mirrors the resolver's catalog
  // provider implication).
  const effectiveProvider =
    provider ??
    (typeof model === "string" ? getCatalogProviderForModel(model) : undefined);

  if (typeof effectiveProvider !== "string" || typeof model !== "string") {
    return undefined;
  }

  const catalogProvider = PROVIDER_CATALOG.find(
    (p) => p.id === effectiveProvider,
  );
  return catalogProvider?.models.find((m) => m.id === model);
}
