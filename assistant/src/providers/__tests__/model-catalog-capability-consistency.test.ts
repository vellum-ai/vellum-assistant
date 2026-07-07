import { describe, expect, test } from "bun:test";

import { getCatalogModelVision, PROVIDER_CATALOG } from "../model-catalog.js";

// Some capability lookups only hold a bare model id (e.g. a
// provider-reported response model) and scan every provider for the first id
// match: `getCatalogModelVision`'s fallback and
// `isAdaptiveThinkingOnlyModel`. Those lookups are only sound while a model
// id never appears under two providers with different values for the flags
// they read. Capabilities that genuinely vary by serving provider (caching,
// thinking, effort ceilings, context windows) are intentionally NOT
// constrained here — when one of the flags below starts varying by provider,
// every provider-agnostic consumer must switch to a (provider, model) lookup
// before the catalog change lands.
describe("model catalog capability consistency", () => {
  test("a model id never carries conflicting provider-agnostic capability flags across providers", () => {
    const seen = new Map<
      string,
      { provider: string; vision: boolean; adaptiveThinkingOnly: boolean }
    >();
    for (const provider of PROVIDER_CATALOG) {
      for (const model of provider.models) {
        const flags = {
          provider: provider.id,
          vision: model.supportsVision ?? false,
          adaptiveThinkingOnly: model.adaptiveThinkingOnly ?? false,
        };
        const prior = seen.get(model.id);
        if (prior != null) {
          expect(
            { id: model.id, ...flags },
            `model id "${model.id}" is listed under both "${prior.provider}" and "${flags.provider}" with different provider-agnostic capability flags`,
          ).toMatchObject({ id: model.id, ...prior, provider: flags.provider });
        }
        seen.set(model.id, flags);
      }
    }
  });

  test("getCatalogModelVision prefers the (provider, model) pair and falls back to a cross-provider scan", () => {
    // Known (provider, model) pair.
    expect(
      getCatalogModelVision("accounts/fireworks/models/glm-5p2", "fireworks"),
    ).toBe(false);
    // Provider not in the catalog (e.g. a wrapper name) — id still resolves.
    expect(
      getCatalogModelVision(
        "accounts/fireworks/models/glm-5p2",
        "some-proxy-wrapper",
      ),
    ).toBe(false);
    // No provider — bare-id fallback.
    expect(getCatalogModelVision("accounts/fireworks/models/glm-5p2")).toBe(
      false,
    );
    // Unknown model id — undefined regardless of provider.
    expect(getCatalogModelVision("no-such-model", "fireworks")).toBeUndefined();
    expect(getCatalogModelVision("no-such-model")).toBeUndefined();
  });
});
