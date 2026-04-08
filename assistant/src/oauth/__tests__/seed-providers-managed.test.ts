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
