import { describe, test, expect } from "bun:test";

import {
  resolveNavigation,
  resolveLoginReturnTo,
  type NavigationState,
  type NavigationDecision,
} from "./navigation-resolver";

const base: NavigationState = {
  isLocalMode: false,
  isPlatformDisabled: false,
  isRemoteGateway: false,
  remoteGatewayPublicPathPrefix: "",
  isGatewayAuth: false,
  hasAssistants: true,
  sessionSettled: true,
  isAuthenticated: true,
  platformSession: "present",
  tosAccepted: true,
  privacyConsent: true,
  analyticsConsentCurrent: true,
  diagnosticsConsentCurrent: true,
  // Hydrated by default so the cases below describe settled-state behavior;
  // the hydration-gating cases override these explicitly.
  consentHydrated: true,
  assistantsHydrated: true,
};

function s(overrides: Partial<NavigationState>): NavigationState {
  return { ...base, ...overrides };
}

const ALLOW: NavigationDecision = { action: "allow" };
const WAIT: NavigationDecision = { action: "wait" };

describe("resolveNavigation", () => {
  // -----------------------------------------------------------------------
  // route-guard
  // -----------------------------------------------------------------------
  describe("route-guard", () => {
    const guard = (state: NavigationState, pathname = "/assistant") =>
      resolveNavigation(state, { kind: "route-guard", pathname });

    test("waits when session not settled", () => {
      expect(guard(s({ sessionSettled: false }))).toEqual(WAIT);
    });

    test("allows gateway auth regardless of auth status", () => {
      expect(guard(s({ isGatewayAuth: true, isAuthenticated: false }))).toEqual(ALLOW);
    });

    // -- unauthenticated --------------------------------------------------

    test("redirects unauthenticated platform user to login", () => {
      expect(guard(s({ isAuthenticated: false }))).toEqual({
        action: "redirect",
        to: "/account/login?returnTo=%2Fassistant",
      });
    });

    test("preserves query string in returnTo", () => {
      const result = guard(s({ isAuthenticated: false }), "/assistant/home?tab=1");
      expect(result).toEqual({
        action: "redirect",
        to: "/account/login?returnTo=%2Fassistant%2Fhome%3Ftab%3D1",
      });
    });

    test("redirects unauthenticated remote-gateway browsers to pairing", () => {
      const result = guard(
        s({
          isAuthenticated: false,
          isLocalMode: true,
          isRemoteGateway: true,
          hasAssistants: true,
        }),
        "/assistant/conversations/self?tab=latest",
      );

      expect(result).toEqual({
        action: "redirect",
        to: "/assistant/pair?returnTo=%2Fassistant%2Fconversations%2Fself%3Ftab%3Dlatest",
      });
    });

    test("strips remote-gateway public prefix from pairing returnTo", () => {
      const result = guard(
        s({
          isAuthenticated: false,
          isLocalMode: true,
          isRemoteGateway: true,
          remoteGatewayPublicPathPrefix: "/assistant-123",
          hasAssistants: true,
        }),
        "/assistant-123/assistant/conversations/self?tab=latest",
      );

      expect(result).toEqual({
        action: "redirect",
        to: "/assistant/pair?returnTo=%2Fassistant%2Fconversations%2Fself%3Ftab%3Dlatest",
      });
    });

    test("allows unauthenticated local-mode user on onboarding route", () => {
      expect(
        guard(
          s({ isAuthenticated: false, isLocalMode: true, hasAssistants: false }),
          "/assistant/welcome",
        ),
      ).toEqual(ALLOW);
    });

    test("allows unauthenticated local-mode user on select-assistant screen", () => {
      expect(
        guard(
          s({ isAuthenticated: false, isLocalMode: true, hasAssistants: true }),
          "/assistant/select-assistant",
        ),
      ).toEqual(ALLOW);
    });

    test("redirects unauthenticated local-mode user from select-assistant to hosting when no assistants", () => {
      expect(
        guard(
          s({ isAuthenticated: false, isLocalMode: true, hasAssistants: false }),
          "/assistant/select-assistant",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/hosting" });
    });

    test("redirects unauthenticated local-mode fresh user to welcome", () => {
      expect(
        guard(s({ isAuthenticated: false, isLocalMode: true, hasAssistants: false })),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
    });

    test("redirects unauthenticated local-mode returning user (has assistants) to select-assistant", () => {
      expect(
        guard(s({ isAuthenticated: false, isLocalMode: true, hasAssistants: true })),
      ).toEqual({ action: "redirect", to: "/assistant/select-assistant" });
    });

    // -- authenticated, onboarding routes ---------------------------------

    test("allows authenticated user on onboarding route regardless of assistant count", () => {
      expect(
        guard(s({}), "/assistant/onboarding/privacy"),
      ).toEqual(ALLOW);
      expect(
        guard(s({ hasAssistants: false }), "/assistant/onboarding/privacy"),
      ).toEqual(ALLOW);
    });

    test("allows authenticated user on review-terms route", () => {
      expect(
        guard(s({}), "/assistant/review-terms"),
      ).toEqual(ALLOW);
    });

    test("query strings do not break onboarding path matching", () => {
      expect(
        guard(s({ hasAssistants: false }), "/assistant/onboarding/privacy?replay=1"),
      ).toEqual(ALLOW);
      expect(
        guard(
          s({ hasAssistants: false, tosAccepted: true, privacyConsent: true }),
          "/assistant/onboarding/hatching?hosting=local",
        ),
      ).toEqual(ALLOW);
    });

    test("redirects authenticated user from select-assistant to hosting when no assistants", () => {
      expect(
        guard(
          s({ isLocalMode: true, hasAssistants: false }),
          "/assistant/select-assistant",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/hosting" });
    });

    test("redirects non-local user from local-only onboarding screen", () => {
      expect(
        guard(s({ isLocalMode: false }), "/assistant/welcome"),
      ).toEqual({ action: "redirect", to: "/assistant" });
      expect(
        guard(s({ isLocalMode: false }), "/assistant/select-assistant"),
      ).toEqual({ action: "redirect", to: "/assistant" });
      expect(
        guard(s({ isLocalMode: false }), "/assistant/onboarding/hosting"),
      ).toEqual({ action: "redirect", to: "/assistant" });
      expect(
        guard(s({ isLocalMode: false }), "/assistant/onboarding/api-key"),
      ).toEqual({ action: "redirect", to: "/assistant" });
    });

    test("allows non-local user on onboarding screens regardless of assistant count", () => {
      expect(
        guard(s({ isLocalMode: false }), "/assistant/onboarding/privacy"),
      ).toEqual(ALLOW);
      expect(
        guard(s({ isLocalMode: false }), "/assistant/onboarding/hatching"),
      ).toEqual(ALLOW);
      expect(
        guard(s({ isLocalMode: false }), "/assistant/onboarding/prechat"),
      ).toEqual(ALLOW);
      expect(
        guard(s({ isLocalMode: false, hasAssistants: false }), "/assistant/onboarding/privacy"),
      ).toEqual(ALLOW);
      expect(
        guard(s({ isLocalMode: false, hasAssistants: false }), "/assistant/onboarding/prechat"),
      ).toEqual(ALLOW);
    });

    test("redirects user from hatching to privacy when consent missing", () => {
      expect(
        guard(
          s({ tosAccepted: false, privacyConsent: false }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("allows user on hatching when consent present", () => {
      expect(
        guard(
          s({ tosAccepted: true, privacyConsent: true }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual(ALLOW);
    });

    test("redirects user from hatching to privacy with partial consent", () => {
      expect(
        guard(
          s({ tosAccepted: true, privacyConsent: false }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("redirects from hatching without consent to privacy when no assistants", () => {
      expect(
        guard(
          s({ hasAssistants: false, tosAccepted: false, privacyConsent: false }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("redirects from hatching without consent in local mode", () => {
      expect(
        guard(
          s({ isLocalMode: true, tosAccepted: false, privacyConsent: false }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
    });

    test("allows hatching with consent when no assistants", () => {
      expect(
        guard(
          s({ hasAssistants: false, tosAccepted: true, privacyConsent: true }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual(ALLOW);
    });

    // -- authenticated, local mode, no assistants -------------------------

    test("waits for platform probe in local mode with no assistants", () => {
      expect(
        guard(s({ isLocalMode: true, hasAssistants: false, platformSession: "unknown" })),
      ).toEqual(WAIT);
    });

    test("redirects to hosting when local mode + platform session present", () => {
      expect(
        guard(s({ isLocalMode: true, hasAssistants: false, platformSession: "present" })),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/hosting" });
    });

    test("redirects to welcome when local mode + no platform session", () => {
      expect(
        guard(s({ isLocalMode: true, hasAssistants: false, platformSession: "absent" })),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
    });

    test("allows local mode with assistants", () => {
      expect(guard(s({ isLocalMode: true, hasAssistants: true }))).toEqual(ALLOW);
    });

    // -- authenticated, platform mode, not onboarded ----------------------

    test("redirects platform-mode user without consent to review-terms with returnTo", () => {
      expect(
        guard(s({ isLocalMode: false, tosAccepted: false, privacyConsent: false })),
      ).toEqual({ action: "redirect", to: "/assistant/review-terms?returnTo=%2Fassistant" });
    });

    test("redirects platform-mode user with partial consent to review-terms with returnTo", () => {
      expect(
        guard(s({ isLocalMode: false, tosAccepted: true, privacyConsent: false })),
      ).toEqual({ action: "redirect", to: "/assistant/review-terms?returnTo=%2Fassistant" });
    });

    test("redirects platform-mode user without consent and no assistants to privacy, not hatching", () => {
      expect(
        guard(s({ isLocalMode: false, tosAccepted: false, privacyConsent: false, hasAssistants: false })),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    // -- hydration gating ---------------------------------------------------

    test("waits (not privacy) for a platform user when the assistants list has not hydrated", () => {
      // Boot race: assistants and consent both start empty/false. Deciding
      // here would dump an established user into the onboarding funnel.
      expect(
        guard(
          s({
            hasAssistants: false,
            tosAccepted: false,
            privacyConsent: false,
            analyticsConsentCurrent: false,
            diagnosticsConsentCurrent: false,
            assistantsHydrated: false,
            consentHydrated: false,
          }),
        ),
      ).toEqual(WAIT);
    });

    test("waits for a platform user when assistants hydrated but consent has not", () => {
      expect(
        guard(
          s({
            hasAssistants: false,
            tosAccepted: false,
            privacyConsent: false,
            assistantsHydrated: true,
            consentHydrated: false,
          }),
        ),
      ).toEqual(WAIT);
    });

    test("redirects to privacy once both hydrated and consent is genuinely false", () => {
      expect(
        guard(
          s({
            hasAssistants: false,
            tosAccepted: false,
            privacyConsent: false,
            assistantsHydrated: true,
            consentHydrated: true,
          }),
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("waits (not review-terms) when consent looks stale but has not hydrated", () => {
      expect(
        guard(
          s({
            hasAssistants: true,
            analyticsConsentCurrent: false,
            consentHydrated: false,
          }),
        ),
      ).toEqual(WAIT);
    });

    test("redirects to review-terms once hydrated consent is genuinely stale", () => {
      expect(
        guard(
          s({
            hasAssistants: true,
            analyticsConsentCurrent: false,
            consentHydrated: true,
          }),
        ),
      ).toEqual({ action: "redirect", to: "/assistant/review-terms?returnTo=%2Fassistant" });
    });

    test("local mode ignores hydration flags (lockfile-driven list, sync consent)", () => {
      // The no-assistants fork keys off the platform probe, not hydration...
      expect(
        guard(
          s({
            isLocalMode: true,
            hasAssistants: false,
            platformSession: "absent",
            assistantsHydrated: false,
            consentHydrated: false,
          }),
        ),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
      // ...and stale-consent enforcement decides immediately: the local paths
      // that enforce consent hydrate synchronously during session init.
      expect(
        guard(
          s({
            isLocalMode: true,
            hasAssistants: true,
            platformSession: "present",
            tosAccepted: false,
            privacyConsent: false,
            consentHydrated: false,
          }),
        ),
      ).toEqual({ action: "redirect", to: "/assistant/review-terms?returnTo=%2Fassistant" });
    });

    // -- stale consent toggles --------------------------------------------

    test("redirects platform user with current tos/ai but stale analytics toggle to review-terms", () => {
      expect(
        guard(s({ isLocalMode: false, analyticsConsentCurrent: false })),
      ).toEqual({ action: "redirect", to: "/assistant/review-terms?returnTo=%2Fassistant" });
    });

    test("redirects platform user with stale diagnostics toggle to review-terms", () => {
      expect(
        guard(s({ isLocalMode: false, diagnosticsConsentCurrent: false })),
      ).toEqual({ action: "redirect", to: "/assistant/review-terms?returnTo=%2Fassistant" });
    });

    test("allows platform user when all four consent flags are current", () => {
      expect(
        guard(
          s({
            isLocalMode: false,
            tosAccepted: true,
            privacyConsent: true,
            analyticsConsentCurrent: true,
            diagnosticsConsentCurrent: true,
          }),
        ),
      ).toEqual(ALLOW);
    });

    test("redirects local-mode user with a platform session and stale consent to review-terms", () => {
      // Consent is gated on the platform session, NOT isLocalMode: a local-mode
      // client logged into the platform still re-reviews stale terms.
      expect(
        guard(
          s({
            isLocalMode: true,
            hasAssistants: true,
            platformSession: "present",
            tosAccepted: false,
            privacyConsent: false,
          }),
        ),
      ).toEqual({ action: "redirect", to: "/assistant/review-terms?returnTo=%2Fassistant" });
    });

    test("does not enforce consent when the platform session is absent", () => {
      expect(
        guard(
          s({
            hasAssistants: true,
            platformSession: "absent",
            tosAccepted: false,
            privacyConsent: false,
            analyticsConsentCurrent: false,
            diagnosticsConsentCurrent: false,
          }),
        ),
      ).toEqual(ALLOW);
    });

    test("does not enforce consent when the platform is disabled", () => {
      expect(
        guard(
          s({
            isPlatformDisabled: true,
            hasAssistants: true,
            platformSession: "present",
            tosAccepted: false,
            privacyConsent: false,
          }),
        ),
      ).toEqual(ALLOW);
    });

    // -- normal authenticated access --------------------------------------

    test("allows authenticated user on normal route", () => {
      expect(guard(s({}))).toEqual(ALLOW);
    });

    test("redirects authenticated platform user without assistants to hatching", () => {
      expect(guard(s({ hasAssistants: false }))).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/hatching",
      });
    });

    test("redirects platform user with consent but no assistants to hatching from deep path", () => {
      expect(
        guard(s({ hasAssistants: false }), "/assistant/home"),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/hatching",
      });
    });

    test("redirects a consented no-assistant platform user to hatching", () => {
      expect(guard(s({ hasAssistants: false }))).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/hatching",
      });
    });

    test("redirects consented platform user with stale analytics toggle and no assistant to review-terms, not hatching", () => {
      expect(
        guard(s({ hasAssistants: false, analyticsConsentCurrent: false })),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant",
      });
    });

    test("redirects consented platform user with stale diagnostics toggle and no assistant to review-terms", () => {
      expect(
        guard(s({ hasAssistants: false, diagnosticsConsentCurrent: false }), "/assistant/home"),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant%2Fhome",
      });
    });

    test("redirects brand-new platform user with no assistant to privacy, unaffected by stale-toggle gate", () => {
      expect(
        guard(
          s({
            hasAssistants: false,
            tosAccepted: false,
            privacyConsent: false,
            analyticsConsentCurrent: false,
            diagnosticsConsentCurrent: false,
          }),
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });
  });

  // -----------------------------------------------------------------------
  // onboarding-intercept
  // -----------------------------------------------------------------------
  describe("onboarding-intercept", () => {
    const intercept = (state: NavigationState, dest: string) =>
      resolveNavigation(state, { kind: "onboarding-intercept", intendedDestination: dest });

    test("allows local mode with assistants", () => {
      expect(intercept(s({ isLocalMode: true, hasAssistants: true }), "/assistant")).toEqual(ALLOW);
    });

    test("allows when tos and consent accepted", () => {
      expect(intercept(s({ tosAccepted: true, privacyConsent: true }), "/assistant")).toEqual(ALLOW);
    });

    test("stale toggles do not change onboarding-intercept (hasCompletedOnboarding only)", () => {
      expect(
        intercept(
          s({ analyticsConsentCurrent: false, diagnosticsConsentCurrent: false }),
          "/assistant",
        ),
      ).toEqual(ALLOW);
    });

    test("allows destination outside /assistant", () => {
      expect(intercept(s({ tosAccepted: false, privacyConsent: false }), "/account/login")).toEqual(ALLOW);
    });

    test("allows destination in /assistant/onboarding", () => {
      expect(
        intercept(s({ tosAccepted: false, privacyConsent: false }), "/assistant/onboarding/privacy"),
      ).toEqual(ALLOW);
    });

    test("redirects to welcome in local mode", () => {
      expect(
        intercept(s({ isLocalMode: true, hasAssistants: false, tosAccepted: false, privacyConsent: false }), "/assistant"),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
    });

    test("redirects to privacy in platform mode", () => {
      expect(intercept(s({ tosAccepted: false, privacyConsent: false }), "/assistant")).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
    });

    test("handles absolute URL destinations", () => {
      expect(
        intercept(s({ tosAccepted: false, privacyConsent: false }), "https://assistant.vellum.ai/assistant"),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("handles protocol-relative URL destinations", () => {
      expect(
        intercept(s({ tosAccepted: false, privacyConsent: false }), "//assistant.vellum.ai/assistant"),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("allows absolute URL outside /assistant", () => {
      expect(
        intercept(s({ tosAccepted: false, privacyConsent: false }), "https://vellum.ai/account"),
      ).toEqual(ALLOW);
    });
  });

  // -----------------------------------------------------------------------
  // hatch-gate
  // -----------------------------------------------------------------------
  describe("hatch-gate", () => {
    const hatch = (state: NavigationState) =>
      resolveNavigation(state, { kind: "hatch-gate" });

    test("waits when session not settled", () => {
      expect(hatch(s({ sessionSettled: false }))).toEqual(WAIT);
    });

    test("redirects unauthenticated platform-mode user to login", () => {
      expect(hatch(s({ isAuthenticated: false, isLocalMode: false }))).toEqual({
        action: "redirect",
        to: "/account/login",
      });
    });

    test("redirects unauthenticated local-mode user without consent to welcome", () => {
      expect(hatch(s({ isAuthenticated: false, isLocalMode: true, tosAccepted: false, privacyConsent: false }))).toEqual({
        action: "redirect",
        to: "/assistant/welcome",
      });
    });

    test("redirects when missing consent", () => {
      expect(hatch(s({ tosAccepted: false, privacyConsent: false }))).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
    });

    test("redirects when missing ai data consent only", () => {
      expect(hatch(s({ tosAccepted: true, privacyConsent: false }))).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
    });

    test("redirects to welcome in local mode when missing consent", () => {
      expect(
        hatch(s({ isLocalMode: true, tosAccepted: false, privacyConsent: false })),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
    });

    test("allows with full consent", () => {
      expect(hatch(s({ tosAccepted: true, privacyConsent: true }))).toEqual(ALLOW);
    });

    test("redirects platform user with stale analytics toggle to review-terms", () => {
      expect(
        hatch(s({ analyticsConsentCurrent: false })),
      ).toEqual({ action: "redirect", to: "/assistant/review-terms" });
    });

    test("redirects platform user with stale diagnostics toggle to review-terms", () => {
      expect(
        hatch(s({ diagnosticsConsentCurrent: false })),
      ).toEqual({ action: "redirect", to: "/assistant/review-terms" });
    });

    test("does not gate local-mode user on stale toggles", () => {
      expect(
        hatch(s({ isLocalMode: true, analyticsConsentCurrent: false, diagnosticsConsentCurrent: false })),
      ).toEqual(ALLOW);
    });
  });

  // -----------------------------------------------------------------------
  // post-retire
  // -----------------------------------------------------------------------
  describe("post-retire", () => {
    const postRetire = (state: NavigationState) =>
      resolveNavigation(state, { kind: "post-retire" });

    test("redirects to select-assistant in local mode when other assistants remain", () => {
      expect(postRetire(s({ hasAssistants: true, isLocalMode: true }))).toEqual({
        action: "redirect",
        to: "/assistant/select-assistant",
      });
    });

    test("redirects to /assistant in platform mode when other assistants remain", () => {
      expect(postRetire(s({ hasAssistants: true, isLocalMode: false }))).toEqual({
        action: "redirect",
        to: "/assistant",
      });
    });

    test("redirects to privacy in platform mode when no assistants remain", () => {
      expect(postRetire(s({ hasAssistants: false, isLocalMode: false }))).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
    });

    test("redirects to hosting in local mode when platform session present", () => {
      expect(
        postRetire(s({ hasAssistants: false, isLocalMode: true, platformSession: "present" })),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/hosting",
      });
    });

    test("redirects to welcome in local mode when no platform session", () => {
      expect(
        postRetire(s({ hasAssistants: false, isLocalMode: true, platformSession: "absent" })),
      ).toEqual({
        action: "redirect",
        to: "/assistant/welcome",
      });
    });
  });

  // -----------------------------------------------------------------------
  // post-auth
  // -----------------------------------------------------------------------
  describe("post-auth", () => {
    const postAuth = (authIntent: "login" | "signup", returnTo: string | null, fallback = "/assistant") =>
      resolveNavigation(base, { kind: "post-auth", authIntent, returnTo, fallback });

    test("signup always goes to privacy", () => {
      expect(postAuth("signup", "/some-return")).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
    });

    test("signup ignores returnTo", () => {
      expect(postAuth("signup", null)).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
    });

    test("login uses returnTo", () => {
      expect(postAuth("login", "/assistant/home")).toEqual({
        action: "redirect",
        to: "/assistant/home",
      });
    });

    test("login falls back when returnTo is null", () => {
      expect(postAuth("login", null)).toEqual({
        action: "redirect",
        to: "/assistant",
      });
    });

    test("login falls back when returnTo is empty", () => {
      expect(postAuth("login", "")).toEqual({
        action: "redirect",
        to: "/assistant",
      });
    });
  });

  // -----------------------------------------------------------------------
  // resolveLoginReturnTo
  // -----------------------------------------------------------------------
  describe("resolveLoginReturnTo", () => {
    test("returns select-assistant from welcome when assistants exist", () => {
      expect(
        resolveLoginReturnTo(s({ hasAssistants: true }), "/assistant/welcome"),
      ).toBe("/assistant/select-assistant");
    });

    test("returns hosting from welcome when no assistants", () => {
      expect(
        resolveLoginReturnTo(s({ hasAssistants: false }), "/assistant/onboarding/hosting"),
      ).toBe("/assistant/onboarding/hosting");
    });

    test("appends fromLogin param when logging in from select-assistant", () => {
      expect(
        resolveLoginReturnTo(s({}), "/assistant/select-assistant"),
      ).toBe("/assistant/select-assistant?fromLogin=1");
    });

    test("returns the same path for other non-welcome pages", () => {
      expect(
        resolveLoginReturnTo(s({}), "/assistant/onboarding/hosting"),
      ).toBe("/assistant/onboarding/hosting");
    });
  });
});
