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

  test("a different contact id is a different actor", () => {
    expect(
      sameTrustIdentity(
        contactTrust({ requesterContactId: "contact-abc" }),
        contactTrust({ requesterContactId: "contact-xyz" }),
      ),
    ).toBe(false);
  });
});
