/**
 * Input-token pricing for a workspace inference profile.
 *
 * A plugin that must choose among several routing-eligible profiles by cost
 * (e.g. picking the cheapest vision-capable profile for image captioning) reads
 * the resolved model's input-token rate through {@link getProfileInputTokenPrice}
 * instead of hardcoding model names or prices.
 */

import { getConfig } from "../config/loader.js";
import {
  resolveDispatchProfileEntry,
  resolveEntryCatalogModel,
} from "./profile-catalog-resolution.js";
import type { ModelProfileInfo } from "./types.js";

/**
 * The catalog input-token price (USD per 1M tokens) of the model a profile
 * resolves to, or `null` when the price is unknown.
 *
 * A `string` argument is a profile key; a {@link ModelProfileInfo} is read for
 * its `key`. The key resolves through the same `llm.defaultProvider`-aware path
 * dispatch uses (see {@link resolveDispatchProfileEntry}), so on a BYOK install
 * a default profile prices the model it actually runs — the default provider's
 * column — not the managed `vellum` body. `null` covers a profile that doesn't
 * resolve to a catalog model, a catalog model that carries no pricing, and a
 * "mix" profile — a mix has no single `(provider, model)`, so its per-call
 * price is indeterminate. Callers ranking profiles by cost treat `null` as
 * "rank last".
 */
export function getProfileInputTokenPrice(
  profile: ModelProfileInfo | string,
): number | null {
  const key = typeof profile === "string" ? profile : profile.key;
  const { llm } = getConfig();
  const entry = resolveDispatchProfileEntry(llm, key);
  if (entry == null || entry.mix != null) {
    return null;
  }
  return resolveEntryCatalogModel(entry)?.pricing?.inputPer1mTokens ?? null;
}

/**
 * The catalog input-token price (USD per 1M tokens) of a concrete model id, or
 * `null` when the catalog doesn't know the model or carries no pricing for it.
 *
 * The same model id can carry different rates under different providers (e.g. a
 * multi-provider model routed through two gateways), so pass the resolved
 * `provider` to price the provider-specific catalog entry. When `provider` is
 * omitted — or names a provider the catalog doesn't offer this model under —
 * the price falls back to the model-id-only lookup (the first catalog provider
 * that offers the model). A routing identity (e.g. `vellum`) resolves through
 * the model's catalog owner.
 *
 * A caller ranking a call site's resolved model against profile prices — e.g.
 * the image-fallback plugin pricing the `vision` call-site default alongside its
 * vision profiles — reads it here so a bare model and a profile rank on the same
 * scale. Callers ranking by cost treat `null` as "rank last".
 */
export function getModelInputTokenPrice(
  model: string,
  provider?: string,
): number | null {
  if (provider != null) {
    const scoped = resolveEntryCatalogModel({ model, provider });
    if (scoped != null) {
      return scoped.pricing?.inputPer1mTokens ?? null;
    }
    // The provider is unknown or doesn't offer this model — fall back to the
    // model-id-only lookup below.
  }
  return resolveEntryCatalogModel({ model })?.pricing?.inputPer1mTokens ?? null;
}
