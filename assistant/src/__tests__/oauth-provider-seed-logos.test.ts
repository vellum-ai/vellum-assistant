import { describe, expect, test } from "bun:test";

import { PROVIDER_SEED_DATA } from "../oauth/seed-providers.js";

describe("PROVIDER_SEED_DATA logo URLs", () => {
  test("every well-known provider has a Simple Icons CDN logoUrl", () => {
    const missing: string[] = [];
    const invalid: Array<{ provider: string; logoUrl: string }> = [];

    for (const [key, seed] of Object.entries(PROVIDER_SEED_DATA)) {
      if (!seed.logoUrl) {
        missing.push(key);
        continue;
      }
      if (!seed.logoUrl.startsWith("https://cdn.simpleicons.org/")) {
        invalid.push({ provider: key, logoUrl: seed.logoUrl });
      }
    }

    expect(missing).toEqual([]);
    expect(invalid).toEqual([]);
  });
});
