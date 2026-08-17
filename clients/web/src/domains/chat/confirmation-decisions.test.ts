/**
 * The decision set is what both confirmation surfaces render from, so these
 * cover the two ways they previously disagreed: the daemon's verbs being
 * honoured on one surface and hardcoded on the other, and the rule option
 * being gated on `persistentDecisionsAllowed` by one and not the other.
 */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CONFIRM_LABEL,
  DEFAULT_DENY_LABEL,
  resolveConfirmationDecisions,
} from "@/domains/chat/confirmation-decisions";

const WITH_OPTIONS = {
  allowlistOptions: [{ label: "*", description: "Everything", pattern: "*" }],
};

describe("resolveConfirmationDecisions", () => {
  test("uses the daemon's verbs when it sends them", () => {
    const decisions = resolveConfirmationDecisions({
      confirmLabel: "Run it",
      denyLabel: "Skip",
    });

    expect(decisions.confirmLabel).toBe("Run it");
    expect(decisions.denyLabel).toBe("Skip");
  });

  test("falls back to Allow/Deny when it does not", () => {
    const decisions = resolveConfirmationDecisions({});

    expect(decisions.confirmLabel).toBe(DEFAULT_CONFIRM_LABEL);
    expect(decisions.denyLabel).toBe(DEFAULT_DENY_LABEL);
  });

  test("offers the rule when options exist and persistence is allowed", () => {
    expect(resolveConfirmationDecisions(WITH_OPTIONS).offersRule).toBe(true);
    expect(
      resolveConfirmationDecisions({
        ...WITH_OPTIONS,
        persistentDecisionsAllowed: true,
      }).offersRule,
    ).toBe(true);
  });

  test("withholds the rule when the daemon demanded fresh approval", () => {
    // The reachable shape: a tool marked `requireFreshApproval` still ships a
    // non-empty allowlist, because the generator's fallback is "Everything".
    // Gating on options alone therefore offers the standing permission the
    // daemon asked to prevent.
    const decisions = resolveConfirmationDecisions({
      ...WITH_OPTIONS,
      persistentDecisionsAllowed: false,
    });

    expect(decisions.offersRule).toBe(false);
  });

  test("withholds the rule when there are no options to build one from", () => {
    expect(resolveConfirmationDecisions({}).offersRule).toBe(false);
    expect(
      resolveConfirmationDecisions({ allowlistOptions: [] }).offersRule,
    ).toBe(false);
  });
});
