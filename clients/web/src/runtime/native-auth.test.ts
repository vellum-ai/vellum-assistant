import { beforeEach, describe, expect, test } from "bun:test";

import {
  readCheckoutIntent,
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";

import { resolveNativePostAuthDestination } from "./native-auth";

describe("resolveNativePostAuthDestination", () => {
  beforeEach(() => {
    sessionStorage.clear();
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
    const destination = resolveNativePostAuthDestination("signup", "/assistant/home");

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

    const destination = resolveNativePostAuthDestination("signup", "/assistant/home");

    expect(destination).toBe("/assistant/onboarding/privacy");
    expect(readCheckoutIntent()).toBeNull();
  });

  test("native non-checkout login clears a stale stash from an abandoned attempt", () => {
    saveCheckoutIntent({ kind: "package", packageKey: "abandoned" });

    const destination = resolveNativePostAuthDestination("login", "/assistant/home");

    expect(destination).toBe("/assistant/home");
    expect(readCheckoutIntent()).toBeNull();
  });
});
