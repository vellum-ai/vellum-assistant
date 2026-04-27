import { describe, expect, test } from "bun:test";

import { isAllowDecision } from "../permissions/types.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isAllowDecision", () => {
  test("returns true for 'allow'", () => {
    expect(isAllowDecision("allow")).toBe(true);
  });

  test("returns false for 'deny'", () => {
    expect(isAllowDecision("deny")).toBe(false);
  });
});
