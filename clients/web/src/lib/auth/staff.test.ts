import { describe, expect, test } from "bun:test";

import { isVellumStaff } from "@/lib/auth/staff";
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

describe("isVellumStaff", () => {
  test("accepts the platform staff bit", () => {
    expect(isVellumStaff(user({ isStaff: true }))).toBe(true);
  });

  test("accepts a Vellum address case-insensitively", () => {
    expect(isVellumStaff(user({ email: "alice@" + "VELLUM.AI" }))).toBe(true);
  });

  test("rejects a lookalike domain", () => {
    // Suffix matching includes the "@", so a domain that merely ends in
    // "vellum.ai" does not qualify.
    expect(isVellumStaff(user({ email: "eve@notvellum.ai" }))).toBe(false);
  });

  test("rejects regular users", () => {
    expect(isVellumStaff(user({ email: "user@example.com" }))).toBe(false);
  });

  test("rejects sessions carrying neither signal", () => {
    // Local gateway sessions have no email and no staff bit.
    expect(isVellumStaff(null)).toBe(false);
    expect(isVellumStaff(user({ email: null }))).toBe(false);
  });
});
