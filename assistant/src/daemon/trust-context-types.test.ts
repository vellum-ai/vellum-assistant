import { describe, expect, test } from "bun:test";

import {
  sameTrustIdentity,
  type TrustContext,
} from "./trust-context-types.js";

function contactTrust(
  overrides: Partial<TrustContext> = {},
): TrustContext {
  return {
    trustClass: "trusted_contact",
    sourceChannel: "slack",
    requesterExternalUserId: "U12345678",
    requesterContactId: "contact-abc",
    ...overrides,
  };
}

describe("sameTrustIdentity", () => {
  test("two identical contact contexts compare equal", () => {
    expect(sameTrustIdentity(contactTrust(), contactTrust())).toBe(true);
  });

  test("a different contact ceiling is a different privilege", () => {
    expect(
      sameTrustIdentity(
        contactTrust({ autoApproveThreshold: "high" }),
        contactTrust({ autoApproveThreshold: "none" }),
      ),
    ).toBe(false);
  });

  test("an absent ceiling does not match a present one", () => {
    expect(
      sameTrustIdentity(
        contactTrust(),
        contactTrust({ autoApproveThreshold: "high" }),
      ),
    ).toBe(false);
    expect(
      sameTrustIdentity(
        contactTrust({ autoApproveThreshold: null }),
        contactTrust({ autoApproveThreshold: "none" }),
      ),
    ).toBe(false);
  });

  test("matching contact ceilings still compare equal", () => {
    expect(
      sameTrustIdentity(
        contactTrust({ autoApproveThreshold: "high" }),
        contactTrust({ autoApproveThreshold: "high" }),
      ),
    ).toBe(true);
    expect(
      sameTrustIdentity(
        contactTrust({ autoApproveThreshold: null }),
        contactTrust({ autoApproveThreshold: null }),
      ),
    ).toBe(true);
  });
});
