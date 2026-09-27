import { describe, expect, test } from "bun:test";

import { GuardianActionDecisionRequestSchema } from "./guardian-actions.js";

describe("GuardianActionDecisionRequestSchema", () => {
  test("accepts every guardian decision action", () => {
    for (const action of [
      "approve_once",
      "reject",
      "trust",
      "verify_code",
      "leave_unverified",
      "block",
    ]) {
      expect(
        GuardianActionDecisionRequestSchema.safeParse({
          requestId: "req-1",
          action,
        }).success,
      ).toBe(true);
    }
  });

  test("rejects an action that is not a decision", () => {
    expect(
      GuardianActionDecisionRequestSchema.safeParse({
        requestId: "req-1",
        action: "approve_always",
      }).success,
    ).toBe(false);
  });

  test("rejects a missing or empty request id", () => {
    expect(
      GuardianActionDecisionRequestSchema.safeParse({ action: "reject" })
        .success,
    ).toBe(false);
    expect(
      GuardianActionDecisionRequestSchema.safeParse({
        requestId: "",
        action: "reject",
      }).success,
    ).toBe(false);
  });
});
