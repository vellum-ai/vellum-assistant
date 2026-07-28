import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearCheckoutIntent,
  readCheckoutIntent,
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";

import {
  clearStaleNativeCheckoutStash,
  resolveNativePostAuthDestination,
} from "./native-auth";

describe("resolveNativePostAuthDestination", () => {
  beforeEach(() => {
    sessionStorage.clear();
    // Reset the module-level in-memory mirror so it can't leak across tests.
    clearCheckoutIntent();
  });

  test("native signup via the checkout deep link stashes the package and still routes to privacy", () => {
    const destination = resolveNativePostAuthDestination(
      "signup",
      "/assistant/checkout?package=super",
    );

    expect(destination).toBe("/assistant/onboarding/privacy");
    expect(readCheckoutIntent()).toMatchObject({
      kind: "package",
      packageKey: "super",
    });
  });

  test("native signup with a non-checkout destination stashes nothing", () => {
    const destination = resolveNativePostAuthDestination(
      "signup",
      "/assistant/home",
    );

    expect(destination).toBe("/assistant/onboarding/privacy");
    expect(readCheckoutIntent()).toBeNull();
  });

  test("native signup with no returnTo routes to privacy and stashes nothing", () => {
    const destination = resolveNativePostAuthDestination("signup", null);

    expect(destination).toBe("/assistant/onboarding/privacy");
    expect(readCheckoutIntent()).toBeNull();
  });

  test("native login keeps its returnTo and stashes nothing even on the checkout link", () => {
    const destination = resolveNativePostAuthDestination(
      "login",
      "/assistant/checkout?package=super",
    );

    expect(destination).toBe("/assistant/checkout?package=super");
    expect(readCheckoutIntent()).toBeNull();
  });

  test("native non-checkout signup clears a stale stash from an abandoned attempt", () => {
    saveCheckoutIntent({ kind: "package", packageKey: "abandoned" });

    const destination = resolveNativePostAuthDestination(
      "signup",
      "/assistant/home",
    );

    expect(destination).toBe("/assistant/onboarding/privacy");
    expect(readCheckoutIntent()).toBeNull();
  });

  test("native non-checkout login clears a stale stash from an abandoned attempt", () => {
    saveCheckoutIntent({ kind: "package", packageKey: "abandoned" });

    const destination = resolveNativePostAuthDestination(
      "login",
      "/assistant/home",
    );

    expect(destination).toBe("/assistant/home");
    expect(readCheckoutIntent()).toBeNull();
  });
});

describe("clearStaleNativeCheckoutStash", () => {
  beforeEach(() => {
    sessionStorage.clear();
    clearCheckoutIntent();
  });

  test("a direct native login with a non-checkout destination clears a stale stash", () => {
    // The direct login form passes no intent and a non-checkout returnTo.
    saveCheckoutIntent({ kind: "package", packageKey: "abandoned" });

    clearStaleNativeCheckoutStash(undefined, "/assistant/home");

    expect(readCheckoutIntent()).toBeNull();
  });

  test("a native login onto a checkout deep link leaves an existing stash in place", () => {
    saveCheckoutIntent({ kind: "package", packageKey: "existing" });

    clearStaleNativeCheckoutStash(
      undefined,
      "/assistant/checkout?package=super",
    );

    expect(readCheckoutIntent()).toMatchObject({
      kind: "package",
      packageKey: "existing",
    });
  });

  test("a signup keeps the stash its resolver just set", () => {
    // A signup owns its stash via `resolveSignupCheckoutDestination`; the entry
    // cleanup must not wipe it just because the destination is the privacy page.
    saveCheckoutIntent({ kind: "package", packageKey: "super" });

    clearStaleNativeCheckoutStash("signup", "/assistant/onboarding/privacy");

    expect(readCheckoutIntent()).toMatchObject({
      kind: "package",
      packageKey: "super",
    });
  });
});
