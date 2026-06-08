import { describe, test, expect } from "bun:test";

import {
  resolveNavigation,
  type NavigationState,
  type NavigationDecision,
} from "./navigation-resolver";

const base: NavigationState = {
  isLocalMode: false,
  isGatewayAuth: false,
  hasAssistants: true,
  sessionSettled: true,
  isAuthenticated: true,
  platformSession: "present",
  tosAccepted: true,
  aiDataConsent: true,
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

    test("allows unauthenticated local-mode user on onboarding route", () => {
      expect(
        guard(
          s({ isAuthenticated: false, isLocalMode: true, hasAssistants: false }),
          "/assistant/onboarding/welcome",
        ),
      ).toEqual(ALLOW);
    });

    test("allows unauthenticated local-mode user on select-assistant screen", () => {
      expect(
        guard(
          s({ isAuthenticated: false, isLocalMode: true, hasAssistants: true }),
          "/assistant/onboarding/select-assistant",
        ),
      ).toEqual(ALLOW);
    });

    test("redirects unauthenticated local-mode user from select-assistant to hosting when no assistants", () => {
      expect(
        guard(
          s({ isAuthenticated: false, isLocalMode: true, hasAssistants: false }),
          "/assistant/onboarding/select-assistant",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/hosting" });
    });

    test("redirects unauthenticated local-mode fresh user to welcome", () => {
      expect(
        guard(s({ isAuthenticated: false, isLocalMode: true, hasAssistants: false })),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/welcome" });
    });

    test("redirects unauthenticated local-mode returning user (has assistants) to select-assistant", () => {
      expect(
        guard(s({ isAuthenticated: false, isLocalMode: true, hasAssistants: true })),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/select-assistant" });
    });

    // -- authenticated, onboarding routes ---------------------------------

    test("allows authenticated user on onboarding route", () => {
      expect(
        guard(s({}), "/assistant/onboarding/privacy"),
      ).toEqual(ALLOW);
    });

    test("query strings do not break onboarding path matching", () => {
      expect(
        guard(s({}), "/assistant/onboarding/privacy?replay=1"),
      ).toEqual(ALLOW);
      expect(
        guard(
          s({ tosAccepted: true, aiDataConsent: true }),
          "/assistant/onboarding/hatching?hosting=local",
        ),
      ).toEqual(ALLOW);
    });

    test("redirects authenticated user from select-assistant to hosting when no assistants", () => {
      expect(
        guard(
          s({ isLocalMode: true, hasAssistants: false }),
          "/assistant/onboarding/select-assistant",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/hosting" });
    });

    test("redirects non-local user from local-only onboarding screen", () => {
      expect(
        guard(s({ isLocalMode: false }), "/assistant/onboarding/welcome"),
      ).toEqual({ action: "redirect", to: "/assistant" });
      expect(
        guard(s({ isLocalMode: false }), "/assistant/onboarding/select-assistant"),
      ).toEqual({ action: "redirect", to: "/assistant" });
      expect(
        guard(s({ isLocalMode: false }), "/assistant/onboarding/hosting"),
      ).toEqual({ action: "redirect", to: "/assistant" });
      expect(
        guard(s({ isLocalMode: false }), "/assistant/onboarding/api-key"),
      ).toEqual({ action: "redirect", to: "/assistant" });
    });

    test("allows non-local user on shared onboarding screens", () => {
      expect(
        guard(s({ isLocalMode: false }), "/assistant/onboarding/privacy"),
      ).toEqual(ALLOW);
      expect(
        guard(s({ isLocalMode: false }), "/assistant/onboarding/prechat"),
      ).toEqual(ALLOW);
    });

    test("redirects from hatching without consent", () => {
      expect(
        guard(
          s({ tosAccepted: false, aiDataConsent: false }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("redirects from hatching without consent in local mode", () => {
      expect(
        guard(
          s({ isLocalMode: true, tosAccepted: false, aiDataConsent: false }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/welcome" });
    });

    test("allows hatching with consent", () => {
      expect(
        guard(
          s({ tosAccepted: true, aiDataConsent: true }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual(ALLOW);
    });

    test("allows hatching with only tos (not ai data consent) — should redirect", () => {
      expect(
        guard(
          s({ tosAccepted: true, aiDataConsent: false }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
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
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/welcome" });
    });

    test("allows local mode with assistants", () => {
      expect(guard(s({ isLocalMode: true, hasAssistants: true }))).toEqual(ALLOW);
    });

    // -- authenticated, platform mode, not onboarded ----------------------

    test("redirects platform-mode user without consent to privacy", () => {
      expect(
        guard(s({ isLocalMode: false, tosAccepted: false, aiDataConsent: false })),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("redirects platform-mode user with partial consent to privacy", () => {
      expect(
        guard(s({ isLocalMode: false, tosAccepted: true, aiDataConsent: false })),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("does not redirect local-mode user without consent (handled by step 5)", () => {
      expect(
        guard(s({ isLocalMode: true, hasAssistants: true, tosAccepted: false, aiDataConsent: false })),
      ).toEqual(ALLOW);
    });

    // -- normal authenticated access --------------------------------------

    test("allows authenticated user on normal route", () => {
      expect(guard(s({}))).toEqual(ALLOW);
    });

    test("allows authenticated platform user without assistants on non-local mode", () => {
      expect(guard(s({ hasAssistants: false }))).toEqual(ALLOW);
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
      expect(intercept(s({ tosAccepted: true, aiDataConsent: true }), "/assistant")).toEqual(ALLOW);
    });

    test("allows destination outside /assistant", () => {
      expect(intercept(s({ tosAccepted: false, aiDataConsent: false }), "/account/login")).toEqual(ALLOW);
    });

    test("allows destination in /assistant/onboarding", () => {
      expect(
        intercept(s({ tosAccepted: false, aiDataConsent: false }), "/assistant/onboarding/privacy"),
      ).toEqual(ALLOW);
    });

    test("redirects to welcome in local mode", () => {
      expect(
        intercept(s({ isLocalMode: true, hasAssistants: false, tosAccepted: false, aiDataConsent: false }), "/assistant"),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/welcome" });
    });

    test("redirects to privacy in platform mode", () => {
      expect(intercept(s({ tosAccepted: false, aiDataConsent: false }), "/assistant")).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
    });

    test("handles absolute URL destinations", () => {
      expect(
        intercept(s({ tosAccepted: false, aiDataConsent: false }), "https://assistant.vellum.ai/assistant"),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("handles protocol-relative URL destinations", () => {
      expect(
        intercept(s({ tosAccepted: false, aiDataConsent: false }), "//assistant.vellum.ai/assistant"),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("allows absolute URL outside /assistant", () => {
      expect(
        intercept(s({ tosAccepted: false, aiDataConsent: false }), "https://vellum.ai/account"),
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
      expect(hatch(s({ isAuthenticated: false, isLocalMode: true, tosAccepted: false, aiDataConsent: false }))).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/welcome",
      });
    });

    test("redirects when missing consent", () => {
      expect(hatch(s({ tosAccepted: false, aiDataConsent: false }))).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
    });

    test("redirects when missing ai data consent only", () => {
      expect(hatch(s({ tosAccepted: true, aiDataConsent: false }))).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
    });

    test("redirects to welcome in local mode when missing consent", () => {
      expect(
        hatch(s({ isLocalMode: true, tosAccepted: false, aiDataConsent: false })),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/welcome" });
    });

    test("allows with full consent", () => {
      expect(hatch(s({ tosAccepted: true, aiDataConsent: true }))).toEqual(ALLOW);
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
        to: "/assistant/onboarding/select-assistant",
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
        to: "/assistant/onboarding/welcome",
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
});
