import { describe, expect, test } from "bun:test";

import type { UserDecision } from "../permissions/types.js";
import { isAllowDecision } from "../permissions/types.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isAllowDecision", () => {
  const allowDecisions: UserDecision[] = [
    "allow",
    "allow_10m",
    "allow_conversation",
    "always_allow",
    "always_allow_high_risk",
    "temporary_override",
  ];

  for (const decision of allowDecisions) {
    test(`returns true for '${decision}'`, () => {
      expect(isAllowDecision(decision)).toBe(true);
    });
  }

  test("returns false for 'deny'", () => {
    expect(isAllowDecision("deny")).toBe(false);
  });

  test("returns false for 'always_deny'", () => {
    expect(isAllowDecision("always_deny")).toBe(false);
  });
});
