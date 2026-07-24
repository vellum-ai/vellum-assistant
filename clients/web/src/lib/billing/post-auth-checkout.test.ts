import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearCheckoutIntent,
  readCheckoutIntent,
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";

import {
  checkoutPackageFromDestination,
  resolveSignupCheckoutDestination,
} from "./post-auth-checkout";

describe("checkoutPackageFromDestination", () => {
  test("returns the package slug for a checkout deep link", () => {
    expect(
      checkoutPackageFromDestination("/assistant/checkout?package=super"),
    ).toBe("super");
  });

  test("returns null for a checkout link without a package", () => {
    expect(checkoutPackageFromDestination("/assistant/checkout")).toBeNull();
  });

  test("returns null for a non-checkout destination", () => {
    expect(checkoutPackageFromDestination("/assistant/home")).toBeNull();
  });
});

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

    expect(result).toEqual({
      destination: "/assistant/onboarding/privacy",
      stashedPackage: "super",
    });
    expect(readCheckoutIntent()).toMatchObject({
      kind: "package",
      packageKey: "super",
    });
  });

  test("signup on a checkout link without a package routes to privacy and stashes nothing", () => {
    const result = resolveSignupCheckoutDestination({
      intent: "signup",
      returnTo: "/assistant/checkout",
    });

    expect(result).toEqual({
      destination: "/assistant/onboarding/privacy",
      stashedPackage: null,
    });
    expect(readCheckoutIntent()).toBeNull();
  });

  test("non-checkout signup routes to privacy and clears a stale stash", () => {
    saveCheckoutIntent({ kind: "package", packageKey: "abandoned" });

    const result = resolveSignupCheckoutDestination({
      intent: "signup",
      returnTo: "/assistant/home",
    });

    expect(result).toEqual({
      destination: "/assistant/onboarding/privacy",
      stashedPackage: null,
    });
    expect(readCheckoutIntent()).toBeNull();
  });

  test("non-checkout login keeps its returnTo and clears a stale stash", () => {
    saveCheckoutIntent({ kind: "package", packageKey: "abandoned" });

    const result = resolveSignupCheckoutDestination({
      intent: "login",
      returnTo: "/assistant/home",
    });

    expect(result).toEqual({
      destination: "/assistant/home",
      stashedPackage: null,
    });
    expect(readCheckoutIntent()).toBeNull();
  });

  test("login on a checkout deep link keeps its returnTo, stashes nothing, and leaves an existing stash untouched", () => {
    saveCheckoutIntent({ kind: "package", packageKey: "existing" });

    const result = resolveSignupCheckoutDestination({
      intent: "login",
      returnTo: "/assistant/checkout?package=super",
    });

    expect(result).toEqual({
      destination: "/assistant/checkout?package=super",
      stashedPackage: null,
    });
    // A checkout deep link is never treated as an unrelated auth, so the
    // stash is left in place rather than discarded.
    expect(readCheckoutIntent()).toMatchObject({
      kind: "package",
      packageKey: "existing",
    });
  });
});
