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
    expect(canUseLlmInspector(user({ isStaff: true }))).toBe(true);
  });

  test("allows Vellum email users case-insensitively", () => {
    expect(canUseLlmInspector(user({ email: "alice@" + "VELLUM.AI" }))).toBe(true);
  });

  test("rejects regular users", () => {
    expect(canUseLlmInspector(user({ email: "user@example.com" }))).toBe(false);
  });
});
