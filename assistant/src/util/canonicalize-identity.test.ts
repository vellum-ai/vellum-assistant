import { describe, expect, test } from "bun:test";

import { inboundIdentitiesMatch } from "./canonicalize-identity.js";

describe("inboundIdentitiesMatch", () => {
  test("matches ids that canonicalize to the same sender", () => {
    expect(inboundIdentitiesMatch("slack", " U123 ", "U123")).toBe(true);
    expect(
      inboundIdentitiesMatch("email", "USER@example.com", "user@example.com"),
    ).toBe(true);
  });

  test("distinct senders do not match", () => {
    expect(inboundIdentitiesMatch("slack", "U123", "U456")).toBe(false);
  });

  test("an empty identifier matches nothing, not even another empty one", () => {
    expect(inboundIdentitiesMatch("slack", "", "")).toBe(false);
    expect(inboundIdentitiesMatch("slack", "  ", "U123")).toBe(false);
  });
});
