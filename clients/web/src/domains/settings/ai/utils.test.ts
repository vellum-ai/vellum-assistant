import { describe, expect, test } from "bun:test";

import { allowsKeylessCustomWebProviderBase } from "@/domains/settings/ai/utils";

describe("allowsKeylessCustomWebProviderBase", () => {
  test("allows only fastCRW custom bases to run without a provider key", () => {
    expect(allowsKeylessCustomWebProviderBase("fastcrw", true)).toBe(true);
    expect(allowsKeylessCustomWebProviderBase("fastcrw", false)).toBe(false);
    expect(allowsKeylessCustomWebProviderBase("tinyfish", true)).toBe(false);
  });
});
