import { describe, expect, test } from "bun:test";

import {
  GUARDIAN_DECISION_ACTION_IDS,
  isDenyingGuardianAction,
  isParkGuardianAction,
} from "../guardian-requests.js";

describe("guardian decision actions", () => {
  test("reject, leave_unverified and block deny; every other action approves", () => {
    const denying = GUARDIAN_DECISION_ACTION_IDS.filter(
      isDenyingGuardianAction,
    );
    expect(denying).toEqual(["reject", "leave_unverified", "block"]);
  });

  test("only leave_unverified parks the sender", () => {
    const parking = GUARDIAN_DECISION_ACTION_IDS.filter(isParkGuardianAction);
    expect(parking).toEqual(["leave_unverified"]);
  });

  test("an absent or unknown action neither denies nor parks", () => {
    expect(isDenyingGuardianAction(undefined)).toBe(false);
    expect(isParkGuardianAction("approve_always")).toBe(false);
  });
});
