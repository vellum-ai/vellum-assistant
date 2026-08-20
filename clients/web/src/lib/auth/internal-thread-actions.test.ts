import { describe, expect, test } from "bun:test";

import { CLIENT_FLAG_DEFAULTS } from "@/lib/feature-flags/feature-flag-catalog";
import { canUseInternalThreadActions } from "@/lib/auth/internal-thread-actions";
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

describe("canUseInternalThreadActions", () => {
  test("allows staff once the flag is on", () => {
    expect(canUseInternalThreadActions(user({ isStaff: true }), true)).toBe(
      true,
    );
  });

  test("allows Vellum email users case-insensitively", () => {
    expect(
      canUseInternalThreadActions(user({ email: "alice@" + "VELLUM.AI" }), true),
    ).toBe(true);
  });

  test("rejects regular users even with the flag on", () => {
    expect(
      canUseInternalThreadActions(user({ email: "user@example.com" }), true),
    ).toBe(false);
  });

  test("the flag is a kill switch that outranks staff", () => {
    // Both halves have to agree, so turning the flag off pulls the affordances
    // from staff too, which is the point of keeping it as a kill switch.
    expect(canUseInternalThreadActions(user({ isStaff: true }), false)).toBe(
      false,
    );
    expect(
      canUseInternalThreadActions(user({ email: "alice@vellum.ai" }), false),
    ).toBe(false);
  });

  test("rejects identity-less sessions", () => {
    // Local-gateway sessions carry no email or staff bit, and unlike the old
    // inspector gate there is no flag-only escape hatch.
    expect(canUseInternalThreadActions(null, true)).toBe(false);
    expect(canUseInternalThreadActions(user({ email: null }), true)).toBe(false);
  });
});

describe("internal-thread-actions flag keys", () => {
  // `use-client-feature-flag-sync` drops any server key the registry does not
  // declare, so both keys must stay declared for the hook's legacy fallback to
  // ever see a value.
  test("declares both the current and legacy keys as client flags", () => {
    expect(CLIENT_FLAG_DEFAULTS).toHaveProperty("internalThreadActions");
    expect(CLIENT_FLAG_DEFAULTS).toHaveProperty("forkFromMessage");
  });

  test("both keys default off", () => {
    expect(CLIENT_FLAG_DEFAULTS.internalThreadActions).toBe(false);
    expect(CLIENT_FLAG_DEFAULTS.forkFromMessage).toBe(false);
  });
});
