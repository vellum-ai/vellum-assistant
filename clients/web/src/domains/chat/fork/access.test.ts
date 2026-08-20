import { describe, expect, test } from "bun:test";

import { canForkConversation } from "@/domains/chat/fork/access";
import type { AuthUser } from "@/stores/auth-store";

function user(overrides: Partial<AuthUser>): AuthUser {
  return {
    kind: "platform",
    id: "user-123",
    username: null,
    email: "user@example.com",
    isStaff: false,
    firstName: "",
    lastName: "",
    ...overrides,
  };
}

describe("canForkConversation", () => {
  test("allows staff once the flag is on", () => {
    expect(canForkConversation(user({ isStaff: true }), true)).toBe(true);
  });

  test("allows Vellum email users case-insensitively", () => {
    expect(
      canForkConversation(user({ email: "alice@" + "VELLUM.AI" }), true),
    ).toBe(true);
  });

  test("rejects regular users even with the flag on", () => {
    expect(canForkConversation(user({ email: "user@example.com" }), true)).toBe(
      false,
    );
  });

  test("the flag is a kill switch that outranks staff", () => {
    // Both halves have to agree, so turning the flag off pulls the affordance
    // from staff too, which is the point of keeping it as a kill switch.
    expect(canForkConversation(user({ isStaff: true }), false)).toBe(false);
    expect(canForkConversation(user({ email: "alice@vellum.ai" }), false)).toBe(
      false,
    );
  });

  test("rejects identity-less sessions", () => {
    // Local-gateway sessions carry no email or staff bit, and there is no
    // flag-only escape hatch the way the LLM inspector has one.
    expect(canForkConversation(null, true)).toBe(false);
    expect(canForkConversation(user({ email: null }), true)).toBe(false);
  });
});
