import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  clearCheckoutIntent,
  readCheckoutIntent,
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";
import { nativeAuthErrorDetail } from "@/domains/account/native-auth-error";

import { ONBOARDED_HATCH_AGE_MS } from "@/domains/onboarding/onboarded-assistant";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

import {
  clearStaleNativeCheckoutStash,
  resolveNativePostAuthDestination,
  startAuthFlow,
} from "./native-auth";

describe("resolveNativePostAuthDestination", () => {
  beforeEach(() => {
    sessionStorage.clear();
    // Reset the module-level in-memory mirror so it can't leak across tests.
    clearCheckoutIntent();
    useResolvedAssistantsStore.setState({ assistants: [] });
  });

  afterEach(() => {
    useResolvedAssistantsStore.setState({ assistants: [] });
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

  test("native signup skips privacy when the assistant is already onboarded", () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "asst-1",
          hatchedAt: new Date(Date.now() - ONBOARDED_HATCH_AGE_MS).toISOString(),
          isLocal: false,
          isPlatformHosted: true,
          isPaired: false,
        },
      ],
    });

    const destination = resolveNativePostAuthDestination(
      "signup",
      "/assistant/home",
    );

    expect(destination).toBe("/assistant/home");
    expect(readCheckoutIntent()).toBeNull();
  });

  test("native login skips a research returnTo when the assistant is already onboarded", () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "asst-1",
          hatchedAt: new Date(Date.now() - ONBOARDED_HATCH_AGE_MS).toISOString(),
          isLocal: false,
          isPlatformHosted: true,
          isPaired: false,
        },
      ],
    });

    expect(
      resolveNativePostAuthDestination("login", routes.onboarding.research),
    ).toBe(routes.assistant);
  });
});

describe("startAuthFlow on Electron", () => {
  const windowWithBridge = window as { vellum?: unknown };

  afterEach(() => {
    delete windowWithBridge.vellum;
  });

  test("a bridge without auth.startOAuth rejects instead of falling into the loopback flow", async () => {
    windowWithBridge.vellum = { platform: "electron" };

    const error = await startAuthFlow("workos", "/account/provider/callback", {
      returnTo: "/assistant/home",
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect(nativeAuthErrorDetail(error)).toBe("desktop_update_required");
  });

  test("a bridge with auth.startOAuth drives the in-app OAuth flow", async () => {
    const startOAuth = mock(() => Promise.resolve({ sessionToken: "" }));
    windowWithBridge.vellum = { platform: "electron", auth: { startOAuth } };

    await startAuthFlow("workos", "/account/provider/callback", {
      returnTo: "/assistant/home",
      intent: "login",
    });

    expect(startOAuth).toHaveBeenCalledTimes(1);
    expect(startOAuth).toHaveBeenCalledWith({ intent: "login" });
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
