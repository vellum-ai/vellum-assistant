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

  test("signup on a custom checkout deep link stashes the marked config and routes to privacy", () => {
    const result = resolveSignupCheckoutDestination({
      intent: "signup",
      returnTo:
        "/assistant/checkout?machine_tier=large&storage_tier=s&credit_tier=credits_50",
    });

    expect(result).toBe("/assistant/onboarding/privacy");
    expect(readCheckoutIntent()).toMatchObject({
      kind: "custom",
      machineTier: "large",
      storageTier: "s",
      creditTier: "credits_50",
      resumeAfterOnboarding: true,
    });
  });

  test("a custom link without the optional dimensions stashes them as null", () => {
    const result = resolveSignupCheckoutDestination({
      intent: "signup",
      returnTo: "/assistant/checkout?storage_tier=xs",
    });

    expect(result).toBe("/assistant/onboarding/privacy");
    expect(readCheckoutIntent()).toMatchObject({
      kind: "custom",
      machineTier: null,
      storageTier: "xs",
      creditTier: null,
      resumeAfterOnboarding: true,
    });
  });

  test("an explicit package wins over stray tier params", () => {
    // The upgrade serializer rejects a body carrying both, so the client picks
    // the same winner it does: the named package.
    resolveSignupCheckoutDestination({
      intent: "signup",
      returnTo: "/assistant/checkout?package=super&storage_tier=m",
    });

    expect(readCheckoutIntent()).toMatchObject({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
  });

  test("a checkout link with tiers the endpoint would reject stashes nothing and clears a stale stash", () => {
    // `xxl` storage 400s server-side, so the link names nothing checkoutable:
    // treat it like any other non-checkout auth rather than carrying a config
    // that cannot be bought.
    saveCheckoutIntent({ kind: "package", packageKey: "abandoned" });

    const result = resolveSignupCheckoutDestination({
      intent: "signup",
      returnTo: "/assistant/checkout?storage_tier=xxl",
    });

    expect(result).toBe("/assistant/onboarding/privacy");
    expect(readCheckoutIntent()).toBeNull();
  });

  test("login on a custom checkout deep link keeps its returnTo and stashes nothing", () => {
    const returnTo =
      "/assistant/checkout?machine_tier=medium&storage_tier=m&credit_tier=credits_25";

    const result = resolveSignupCheckoutDestination({
      intent: "login",
      returnTo,
    });

    // The checkout page itself validates and runs the upgrade for a login.
    expect(result).toBe(returnTo);
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
