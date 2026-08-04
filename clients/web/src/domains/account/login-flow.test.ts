import { describe, expect, test } from "bun:test";

import {
  buildProviderCallbackUrl,
  readAuthCallbackIntent,
  requiresFullPageNavigation,
  requiresPlatformSession,
  resolvePostAuthDestination,
} from "@/domains/account/login-flow";
import { routes } from "@/utils/routes";

describe("login flow routing", () => {
  test("marks signup provider callbacks with an auth intent", () => {
    expect(
      buildProviderCallbackUrl(routes.assistant, { authIntent: "signup" }),
    ).toBe(
      `${routes.account.providerCallback}?returnTo=%2Fassistant&authIntent=signup`,
    );
  });

  test("reads signup callback intent", () => {
    expect(
      readAuthCallbackIntent(new URLSearchParams("authIntent=signup")),
    ).toBe("signup");
    expect(readAuthCallbackIntent(new URLSearchParams())).toBe("login");
  });

  test("routes completed signups into onboarding instead of chat", () => {
    expect(
      resolvePostAuthDestination({
        returnTo: routes.assistant,
        fallback: routes.assistant,
        authIntent: "signup",
      }),
    ).toEqual({
      destination: routes.onboarding.privacy,
      requiresFullPageNavigation: false,
    });
  });

  test("keeps normal login returnTo behavior", () => {
    expect(
      resolvePostAuthDestination({
        returnTo: routes.home,
        fallback: routes.assistant,
        authIntent: "login",
      }),
    ).toEqual({
      destination: routes.home,
      requiresFullPageNavigation: false,
    });
  });

  test("resolves CLI login callback returnTo with full-page navigation", () => {
    const cliCallback = "/accounts/cli/callback?port=54321&state=abc123";
    expect(
      resolvePostAuthDestination({
        returnTo: cliCallback,
        fallback: routes.assistant,
        authIntent: "login",
      }),
    ).toEqual({
      destination: cliCallback,
      requiresFullPageNavigation: true,
    });
  });

  test("requiresFullPageNavigation for /accounts/ paths", () => {
    expect(
      requiresFullPageNavigation("/accounts/cli/callback?port=12345&state=xyz"),
    ).toBe(true);
    expect(
      requiresFullPageNavigation(
        "/accounts/native/callback?scheme=vellum&state=abc",
      ),
    ).toBe(true);
    expect(requiresFullPageNavigation("/v1/some-api")).toBe(true);
    expect(requiresFullPageNavigation("https://www.vellum.ai/assistant")).toBe(
      true,
    );
    expect(requiresFullPageNavigation("/assistant")).toBe(false);
    expect(requiresFullPageNavigation("/onboarding/privacy")).toBe(false);
  });

  test("requiresFullPageNavigation for the marketing import funnel", () => {
    // /import is served by the platform Next.js app, not this SPA.
    expect(requiresFullPageNavigation("/import")).toBe(true);
    expect(requiresFullPageNavigation("/import?utm_source=hermes")).toBe(true);
  });
});

describe("requiresPlatformSession", () => {
  const BILLING_LANDING = `${routes.settings.root}/billing`;
  const STRIPE_RETURN = "session_id=cs_test_123";
  const PAID_HATCH = `${routes.onboarding.hatching}?hosting=vellum-cloud&post_checkout=1`;

  test.each([
    [routes.checkout],
    [`${routes.checkout}?package=mighty`],
    [routes.plans],
    [`${routes.plans}?package=mighty`],
    [BILLING_LANDING],
    [`${BILLING_LANDING}?${STRIPE_RETURN}`],
    [routes.settings.upgradeSuccess],
    [routes.settings.upgradeCancel],
    [`${routes.settings.usage}?${STRIPE_RETURN}`],
    [`${routes.settings.usage}?tab=billing&${STRIPE_RETURN}`],
    [PAID_HATCH],
    [routes.account.root],
    ["/import?foo=1"],
    ["/accounts/cli/callback?port=1"],
    ["https://app.vellum.ai/x"],
  ])("%s needs a platform session", (destination) => {
    expect(requiresPlatformSession(destination)).toBe(true);
  });

  test.each([
    [routes.assistant],
    [routes.settings.general],
    ["/assistant/conversations/abc"],
    // The Usage tab reads from the local daemon, so only its Stripe return leg
    // is platform-bound.
    [routes.settings.usage],
    [routes.settings.usageBilling],
    // A managed hatch a free user chose carries no purchase to lose.
    [routes.onboarding.hatching],
    [`${routes.onboarding.hatching}?hosting=vellum-cloud`],
  ])("%s works on a local gateway identity", (destination) => {
    expect(requiresPlatformSession(destination)).toBe(false);
  });

  test("matches sub-paths, not siblings that merely share a prefix", () => {
    expect(requiresPlatformSession(`${routes.plans}/detail`)).toBe(true);
    expect(requiresPlatformSession(`${routes.plans}-archive`)).toBe(false);
    expect(requiresPlatformSession(`${routes.account.root}/login`)).toBe(true);
    expect(requiresPlatformSession("/accountant")).toBe(false);
  });
});
