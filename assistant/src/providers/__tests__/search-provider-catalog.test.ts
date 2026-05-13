import { describe, expect, test } from "bun:test";

import {
  BYOK_SEARCH_PROVIDERS,
  getSearchProvider,
  SEARCH_PROVIDER_CATALOG,
  SEARCH_PROVIDER_FALLBACK_ORDER,
  SEARCH_PROVIDER_IDS,
} from "../search-provider-catalog.js";

describe("search-provider-catalog", () => {
  test("declares at least one provider", () => {
    expect(SEARCH_PROVIDER_CATALOG.length).toBeGreaterThan(0);
  });

  test("provider ids are unique", () => {
    const ids = SEARCH_PROVIDER_CATALOG.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every BYOK provider has the full set of required fields", () => {
    for (const provider of BYOK_SEARCH_PROVIDERS) {
      expect(provider.apiKeyPrefix, `${provider.id}.apiKeyPrefix`).toBeDefined();
      expect(provider.envVar, `${provider.id}.envVar`).toBeDefined();
      expect(provider.secretKey, `${provider.id}.secretKey`).toBeDefined();
      expect(
        provider.fallbackOrder,
        `${provider.id}.fallbackOrder`,
      ).toBeDefined();
      expect(
        provider.privacyPolicyUrl,
        `${provider.id}.privacyPolicyUrl`,
      ).toBeDefined();
    }
  });

  test("managed providers omit BYOK-only fields", () => {
    const managed = SEARCH_PROVIDER_CATALOG.filter((p) => p.kind === "managed");
    for (const provider of managed) {
      expect(provider.envVar).toBeUndefined();
      expect(provider.secretKey).toBeUndefined();
      expect(provider.apiKeyPrefix).toBeUndefined();
      expect(provider.fallbackOrder).toBeUndefined();
    }
  });

  test("env vars are unique across BYOK providers", () => {
    const envVars = BYOK_SEARCH_PROVIDERS.map((p) => p.envVar);
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  test("secret keys are unique across BYOK providers", () => {
    const secretKeys = BYOK_SEARCH_PROVIDERS.map((p) => p.secretKey);
    expect(new Set(secretKeys).size).toBe(secretKeys.length);
  });

  test("fallback order values are unique", () => {
    const orders = BYOK_SEARCH_PROVIDERS.map((p) => p.fallbackOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  test("SEARCH_PROVIDER_IDS contains every catalog id in declaration order", () => {
    expect(SEARCH_PROVIDER_IDS).toEqual(
      SEARCH_PROVIDER_CATALOG.map((p) => p.id),
    );
  });

  test("SEARCH_PROVIDER_FALLBACK_ORDER is sorted by ascending fallbackOrder", () => {
    const sorted = BYOK_SEARCH_PROVIDERS.slice()
      .sort((a, b) => (a.fallbackOrder ?? 0) - (b.fallbackOrder ?? 0))
      .map((p) => p.id);
    expect(SEARCH_PROVIDER_FALLBACK_ORDER).toEqual(sorted);
  });

  test("getSearchProvider returns the matching entry", () => {
    expect(getSearchProvider("tavily")?.id).toBe("tavily");
    expect(getSearchProvider("brave")?.displayName).toBe("Brave");
    expect(getSearchProvider("unknown-xyz")).toBeUndefined();
  });
});
