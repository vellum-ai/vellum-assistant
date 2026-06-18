import { describe, expect, test } from "bun:test";

import { MANAGED_PROFILE_NAMES } from "../seed-inference-profiles.js";

describe("MANAGED_PROFILE_NAMES", () => {
  test("contains exactly the managed profile keys plus the auto key", () => {
    expect(new Set(MANAGED_PROFILE_NAMES)).toEqual(
      new Set([
        "balanced",
        "quality-optimized",
        "cost-optimized",
        "balanced-economy",
        "auto",
      ]),
    );
  });
});
