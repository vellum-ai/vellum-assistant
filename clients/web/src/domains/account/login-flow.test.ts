import { describe, expect, test } from "bun:test";

import {
  buildProviderCallbackUrl,
  readAuthCallbackIntent,
  requiresFullPageNavigation,
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
    expect(readAuthCallbackIntent(new URLSearchParams("authIntent=signup"))).toBe(
      "signup",
    );
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

  test("resolves platform-path returnTo with full-page navigation", () => {
    const platformPath = "/accounts/login?next=%2Fassistant";
    expect(
      resolvePostAuthDestination({
        returnTo: platformPath,
        fallback: routes.assistant,
        authIntent: "login",
      }),
    ).toEqual({
      destination: platformPath,
      requiresFullPageNavigation: true,
    });
  });

  test("requiresFullPageNavigation for platform-proxied paths", () => {
    expect(requiresFullPageNavigation("/accounts/login")).toBe(true);
    expect(requiresFullPageNavigation("/_allauth/browser/v1/auth/session")).toBe(true);
    expect(requiresFullPageNavigation("/v1/some-api")).toBe(true);
    expect(requiresFullPageNavigation("https://www.vellum.ai/assistant")).toBe(true);
    expect(requiresFullPageNavigation("/assistant")).toBe(false);
    expect(requiresFullPageNavigation("/onboarding/privacy")).toBe(false);
  });
});
