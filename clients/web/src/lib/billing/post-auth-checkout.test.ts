import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearCheckoutIntent,
  readCheckoutIntent,
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";

import { resolveSignupCheckoutDestination } from "./post-auth-checkout";

describe("resolveSignupCheckoutDestination", () => {
  beforeEach(() => {
    sessionStorage.clear();
    // Reset the module-level in-memory mirror so it can't leak across tests.
    clearCheckoutIntent();
  });

  test("signup on a checkout deep link stashes the package and routes to privacy", () => {
    const result = resolveSignupCheckoutDestination({
      intent: "signup",
      returnTo: "/assistant/checkout?package=super",
    });

    expect(result).toBe("/assistant/onboarding/privacy");
    // The signup carry marks its stash so only the onboarding privacy screen
    // resumes it — an ordinary billing-surface stash carries no such marker.
    expect(readCheckoutIntent()).toMatchObject({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
  });

  test("signup on a checkout link without a package routes to privacy and stashes nothing", () => {
    const result = resolveSignupCheckoutDestination({
      intent: "signup",
      returnTo: "/assistant/checkout",
    });

    expect(result).toBe("/assistant/onboarding/privacy");
    expect(readCheckoutIntent()).toBeNull();
  });

  test("non-checkout signup routes to privacy and clears a stale stash", () => {
    saveCheckoutIntent({ kind: "package", packageKey: "abandoned" });

    const result = resolveSignupCheckoutDestination({
      intent: "signup",
      returnTo: "/assistant/home",
    });

    expect(result).toBe("/assistant/onboarding/privacy");
    expect(readCheckoutIntent()).toBeNull();
  });

  test("non-checkout login keeps its returnTo and clears a stale stash", () => {
    saveCheckoutIntent({ kind: "package", packageKey: "abandoned" });

    const result = resolveSignupCheckoutDestination({
      intent: "login",
      returnTo: "/assistant/home",
    });

    expect(result).toBe("/assistant/home");
    expect(readCheckoutIntent()).toBeNull();
  });

  test("login on a checkout deep link keeps its returnTo, stashes nothing, and leaves an existing stash untouched", () => {
    saveCheckoutIntent({ kind: "package", packageKey: "existing" });

    const result = resolveSignupCheckoutDestination({
      intent: "login",
      returnTo: "/assistant/checkout?package=super",
    });

    expect(result).toBe("/assistant/checkout?package=super");
    // A checkout deep link is never treated as an unrelated auth, so the
    // stash is left in place rather than discarded.
    expect(readCheckoutIntent()).toMatchObject({
      kind: "package",
      packageKey: "existing",
    });
  });
});
