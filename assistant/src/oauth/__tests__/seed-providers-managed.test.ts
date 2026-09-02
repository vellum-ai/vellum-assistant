import { describe, expect, test } from "bun:test";

import { ServicesSchema } from "../../config/schemas/services.js";
import { PROVIDER_SEED_DATA } from "../seed-providers.js";

describe("PROVIDER_SEED_DATA managed mode wiring", () => {
  test("github provider is wired up for managed mode", () => {
    const github = PROVIDER_SEED_DATA.github;
    expect(github).toBeDefined();
    expect(github.managedServiceConfigKey).toBe("github-oauth");
    expect("github-oauth" in ServicesSchema.shape).toBe(true);
  });

  test("monday only exposes scopes supported by its OAuth API", () => {
    const monday = PROVIDER_SEED_DATA.monday;
    expect(monday).toBeDefined();
    expect(monday.defaultScopes).not.toContain("items:read");
    expect(monday.defaultScopes).not.toContain("items:write");

    const availableScopes = monday.availableScopes;
    expect(Array.isArray(availableScopes)).toBe(true);
    if (Array.isArray(availableScopes)) {
      expect(availableScopes.map(({ scope }) => scope)).not.toContain(
        "items:read",
      );
      expect(availableScopes.map(({ scope }) => scope)).not.toContain(
        "items:write",
      );
    }
  });

  test("google base URL is host-only so relative paths select the product", () => {
    // A host-only base URL (no product path) lets a relative request path pick
    // the Google product — Gmail (/gmail/v1/...), Calendar (/calendar/v3/...),
    // Drive (/drive/v3/...) — instead of pinning every relative request to one
    // product's path prefix.
    expect(PROVIDER_SEED_DATA.google.baseUrl).toBe(
      "https://www.googleapis.com",
    );
  });

  test("every managedServiceConfigKey resolves to a ServicesSchema key", () => {
    // Cross-repo invariant: a provider with managedServiceConfigKey but no
    // matching ServicesSchema entry silently falls back to BYO mode in
    // connection-resolver.ts. This test guards against that drift.
    const offenders: Array<{ provider: string; key: string }> = [];
    for (const [provider, seed] of Object.entries(PROVIDER_SEED_DATA)) {
      const key = seed.managedServiceConfigKey;
      if (key && !(key in ServicesSchema.shape)) {
        offenders.push({ provider, key });
      }
    }
    expect(offenders).toEqual([]);
  });

  test("github managed service schema defaults to your-own", () => {
    const parsed = ServicesSchema.shape["github-oauth"].parse({});
    expect(parsed.mode).toBe("your-own");
  });
});
