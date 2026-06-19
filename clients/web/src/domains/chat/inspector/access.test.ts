import { describe, expect, test } from "bun:test";

import { canUseLlmInspector } from "@/domains/chat/inspector/access";
import type { AuthUser } from "@/stores/auth-store";

function user(overrides: Partial<AuthUser>): AuthUser {
  return {
    id: "user-123",
    username: null,
    email: "user@example.com",
    isStaff: false,
    firstName: "",
    lastName: "",
    ...overrides,
  };
}

describe("canUseLlmInspector", () => {
  test("allows staff users", () => {
    expect(canUseLlmInspector(user({ isStaff: true }), false)).toBe(true);
  });

  test("allows Vellum email users case-insensitively", () => {
    expect(
      canUseLlmInspector(user({ email: "alice@" + "VELLUM.AI" }), false),
    ).toBe(true);
  });

  test("rejects regular users", () => {
    expect(canUseLlmInspector(user({ email: "user@example.com" }), false)).toBe(
      false,
    );
  });

  test("allows any session when the developer-nav flag is enabled", () => {
    // Local-gateway sessions carry no email or staff bit — the flag is
    // their only path to the inspector.
    expect(canUseLlmInspector(null, true)).toBe(true);
    expect(canUseLlmInspector(user({ email: null }), true)).toBe(true);
  });

  test("rejects identity-less sessions when the flag is off", () => {
    expect(canUseLlmInspector(null, false)).toBe(false);
    expect(canUseLlmInspector(user({ email: null }), false)).toBe(false);
  });
});
