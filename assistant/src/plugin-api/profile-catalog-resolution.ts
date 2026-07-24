/**
 * Resolve a workspace profile entry to its effective catalog model.
 *
 * Vision-capability and input-token pricing both need the concrete
 * {@link CatalogModel} a profile's `(provider, model)` resolves to, so the
 * resolution lives here once and each caller reads the field it needs off the
 * returned model. They also both need the effective {@link ProfileEntry} a
 * profile key resolves to under `llm.defaultProvider`, which
 * {@link resolveDispatchProfileEntry} centralizes.
 */

import { resolveDefaultProfileForProvider } from "../config/default-profile-catalog.js";
import type {
  DefaultProviderConfig,
  ProfileEntry,
} from "../config/schemas/llm.js";
import { ROUTING_IDENTITY_PROVIDERS } from "../providers/inference/auth.js";
import {
  type CatalogModel,
  getCatalogProviderForModel,
  PROVIDER_CATALOG,
} from "../providers/model-catalog.js";

/**
 * Resolve a profile key to the effective {@link ProfileEntry} dispatch would
 * run it as, honoring `llm.defaultProvider`.
 *
 * A default profile key (`balanced`, `quality-optimized`, `cost-optimized`)
 * resolves through the default provider's column of the intent × provider
 * matrix — the same body `getConfiguredProvider(callSite, { overrideProfile })`
 * dereferences via the resolver's `providerAwareEntry` — so a BYOK install
 * prices and capability-checks the model it actually runs, not the managed
 * `vellum` body. A `null`/absent `defaultProvider` and every non-default key
 * fall back to the plain effective-profile resolution. Returns `undefined` when
 * the key is unknown.
 *
 * Callers that only need the `(provider, model)` — pricing and vision — read it
 * off the returned entry; a "mix" entry is returned as-is (its arms are
 * resolved individually) so the caller keeps its own mix semantics.
 */
export function resolveDispatchProfileEntry(
  llm: {
    profiles?: Record<string, ProfileEntry>;
    defaultProvider?: DefaultProviderConfig | null;
  },
  name: string,
): ProfileEntry | undefined {
  return resolveDefaultProfileForProvider(
    llm.profiles,
    name,
    llm.defaultProvider ?? null,
  );
}

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
