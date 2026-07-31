import { describe, expect, test } from "bun:test";

import { creditTierKeyUsd } from "./credit-tiers";

describe("creditTierKeyUsd", () => {
  test("reads the amount a catalog-listed tier key names", () => {
    expect(creditTierKeyUsd("credits_25")).toBe(25);
    expect(creditTierKeyUsd("credits_115")).toBe(115);
  });

  test("prices a held tier the catalog no longer lists", () => {
    expect(creditTierKeyUsd("credits_50")).toBe(50);
  });

  test("returns null for the absence of a tier", () => {
    expect(creditTierKeyUsd(null)).toBeNull();
    expect(creditTierKeyUsd(undefined)).toBeNull();
  });

  test("returns null for a key that names no amount", () => {
    expect(creditTierKeyUsd("credits")).toBeNull();
    expect(creditTierKeyUsd("credits_")).toBeNull();
    expect(creditTierKeyUsd("credits_pro")).toBeNull();
    expect(creditTierKeyUsd("credits_25_extra")).toBeNull();
    expect(creditTierKeyUsd("legacy_25")).toBeNull();
  });
});
