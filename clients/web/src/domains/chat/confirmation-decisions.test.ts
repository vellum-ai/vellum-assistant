/**
 * The rule option is the one thing a confirmation's choices vary on, and both
 * surfaces plus the submit path read this predicate, so a request that forbids
 * a durable rule must never be offered one anywhere.
 */
import { describe, expect, test } from "bun:test";

import { offersRuleOption } from "@/domains/chat/confirmation-decisions";

const WITH_OPTIONS = {
  allowlistOptions: [{ label: "*", description: "Everything", pattern: "*" }],
};

describe("offersRuleOption", () => {
  test("offers the rule when options exist and persistence is allowed", () => {
    expect(offersRuleOption(WITH_OPTIONS)).toBe(true);
    expect(
      offersRuleOption({ ...WITH_OPTIONS, persistentDecisionsAllowed: true }),
    ).toBe(true);
  });

  test("withholds the rule when the daemon demanded fresh approval", () => {
    // The reachable shape: a tool marked `requireFreshApproval` still ships a
    // non-empty allowlist, because the generator's fallback is "Everything".
    // Gating on options alone therefore offers the standing permission the
    // daemon asked to prevent.
    expect(
      offersRuleOption({ ...WITH_OPTIONS, persistentDecisionsAllowed: false }),
    ).toBe(false);
  });

  test("withholds the rule when there are no options to build one from", () => {
    expect(offersRuleOption({})).toBe(false);
    expect(offersRuleOption({ allowlistOptions: [] })).toBe(false);
  });
});
