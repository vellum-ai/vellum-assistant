import { describe, expect, test } from "bun:test";

import { resolveGuardianDecisionOptions } from "./guardian-decision-options";

describe("resolveGuardianDecisionOptions", () => {
  test("a projection without decisions offers the generic approval pair", () => {
    expect(resolveGuardianDecisionOptions({}).map((o) => o.id)).toEqual([
      "approve_once",
      "reject",
    ]);
  });

  test("a projection's decisions are offered in its order", () => {
    expect(
      resolveGuardianDecisionOptions({
        decisionActions: [
          { id: "trust", emphasis: "primary" },
          { id: "block", emphasis: "destructive" },
        ],
      }),
    ).toEqual([
      { id: "trust", emphasis: "primary" },
      { id: "block", emphasis: "destructive" },
    ]);
  });

  test("a decision this client does not know is skipped", () => {
    expect(
      resolveGuardianDecisionOptions({
        decisionActions: [{ id: "approve_forever" }, { id: "reject" }],
      }).map((o) => o.id),
    ).toEqual(["reject"]);
  });
});
