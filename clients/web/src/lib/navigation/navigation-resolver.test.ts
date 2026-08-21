import { beforeEach, describe, test, expect } from "bun:test";

import {
  clearCheckoutIntent,
  readCheckoutIntent,
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";

import {
  postCheckoutHatchReturnTo,
  resolveNavigation,
  resolveLoginReturnTo,
  type NavigationState,
  type NavigationDecision,
} from "./navigation-resolver";

const base: NavigationState = {
  isLocalClient: false,
  isPlatformDisabled: false,
  isRemoteGateway: false,
  remoteGatewayPublicPathPrefix: "",
  isGatewayAuth: false,
  hasAssistants: true,
  hasPlatformHostedAssistant: true,
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
  alreadyOnboarded: false,
};

function s(overrides: Partial<NavigationState>): NavigationState {
  return { ...base, ...overrides };
}

/** The path a redirect decision targets, ignoring its query. */
function redirectPath(decision: NavigationDecision): string | null {
  if (decision.action !== "redirect") {
    return null;
  }
  const qIdx = decision.to.indexOf("?");
  return qIdx < 0 ? decision.to : decision.to.slice(0, qIdx);
}

// The two provisioning funnel entries a paid return can name. Both carry the
// managed-hatch marker, so a local-mode client provisions on the platform
// instead of letting its own gateway answer for the assistant and skipping the
// purchased-provisioning wait, plus the post-checkout marker that tells that
// wait a still-base subscription read is a lagging webhook, not a free org.
const RESEARCH_FUNNEL_URL =
  "/assistant/onboarding/research?hosting=vellum-cloud&post_checkout=1";
const HATCHING_FUNNEL_URL =
  "/assistant/onboarding/hatching?hosting=vellum-cloud&post_checkout=1";

const CHOOSER = "/assistant/select-assistant";
/** A platform account with nothing resolved: the chooser's empty state. */
const NO_ASSISTANTS: Partial<NavigationState> = {
  isLocalClient: false,
  hasAssistants: false,
  hasPlatformHostedAssistant: false,
};

const ALLOW: NavigationDecision = { action: "allow" };
const WAIT: NavigationDecision = { action: "wait" };
// The auth middleware awaits the probe only for a wait that names it, so the
// tag is part of the contract, not a label.
const WAIT_FOR_PLATFORM_SESSION: NavigationDecision = {
  action: "wait",
  waitFor: "platform-session",
};

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
      expect(guard(s({ isGatewayAuth: true, isAuthenticated: false }))).toEqual(
        ALLOW,
      );
    });

    // -- unauthenticated --------------------------------------------------

    test("redirects unauthenticated platform user to login", () => {
      expect(guard(s({ isAuthenticated: false }))).toEqual({
        action: "redirect",
        to: "/account/login?returnTo=%2Fassistant",
      });
    });

    test("preserves query string in returnTo", () => {
      const result = guard(
        s({ isAuthenticated: false }),
        "/assistant/home?tab=1",
      );
      expect(result).toEqual({
        action: "redirect",
        to: "/account/login?returnTo=%2Fassistant%2Fhome%3Ftab%3D1",
      });
    });

    test("redirects unauthenticated remote-gateway browsers to pairing", () => {
      const result = guard(
        s({
          isAuthenticated: false,
          isLocalClient: true,
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
          isLocalClient: true,
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
          s({
            isAuthenticated: false,
            isLocalClient: true,
            hasAssistants: false,
          }),
          "/assistant/welcome",
        ),
      ).toEqual(ALLOW);
    });

    test("allows unauthenticated local-mode user on select-assistant screen", () => {
      expect(
        guard(
          s({ isAuthenticated: false, isLocalClient: true, hasAssistants: true }),
          "/assistant/select-assistant",
        ),
      ).toEqual(ALLOW);
    });

    test("redirects unauthenticated local-mode user from select-assistant to hosting when no assistants", () => {
      expect(
        guard(
          s({
            isAuthenticated: false,
            isLocalClient: true,
            hasAssistants: false,
          }),
          "/assistant/select-assistant",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/hosting" });
    });

    test("redirects unauthenticated local-mode fresh user to welcome", () => {
      expect(
        guard(
          s({
            isAuthenticated: false,
            isLocalClient: true,
            hasAssistants: false,
          }),
        ),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
    });

    test("redirects unauthenticated local-mode returning user (has assistants) to select-assistant", () => {
      expect(
        guard(
          s({ isAuthenticated: false, isLocalClient: true, hasAssistants: true }),
        ),
      ).toEqual({ action: "redirect", to: "/assistant/select-assistant" });
    });

    // -- authenticated, onboarding routes ---------------------------------

    test("allows authenticated user on onboarding route regardless of assistant count", () => {
      expect(guard(s({}), "/assistant/onboarding/privacy")).toEqual(ALLOW);
      expect(
        guard(s({ hasAssistants: false }), "/assistant/onboarding/privacy"),
      ).toEqual(ALLOW);
    });

    test("bounces an already-onboarded user off first-run privacy", () => {
      expect(
        guard(s({ alreadyOnboarded: true }), "/assistant/onboarding/privacy"),
      ).toEqual({ action: "redirect", to: "/assistant" });
      expect(
        guard(
          s({ alreadyOnboarded: true, hasAssistants: false }),
          "/assistant/onboarding/privacy?replay=1",
        ),
      ).toEqual({ action: "redirect", to: "/assistant" });
    });

    test("resumes a paid hatch when bouncing an already-onboarded user off privacy", () => {
      expect(
        guard(
          s({ alreadyOnboarded: true }),
          `/assistant/onboarding/privacy?returnTo=${encodeURIComponent(HATCHING_FUNNEL_URL)}`,
        ),
      ).toEqual({ action: "redirect", to: HATCHING_FUNNEL_URL });
    });

    test("keeps research reachable on demand for an already-onboarded user", () => {
      expect(
        guard(s({ alreadyOnboarded: true }), "/assistant/onboarding/research"),
      ).toEqual(ALLOW);
    });

    test("allows authenticated user on review-terms route", () => {
      expect(guard(s({}), "/assistant/review-terms")).toEqual(ALLOW);
    });

    test("query strings do not break onboarding path matching", () => {
      expect(
        guard(
          s({ hasAssistants: false }),
          "/assistant/onboarding/privacy?replay=1",
        ),
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
          s({ isLocalClient: true, hasAssistants: false }),
          "/assistant/select-assistant",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/hosting" });
    });

    test("redirects non-local user from local-only onboarding screen", () => {
      expect(guard(s({ isLocalClient: false }), "/assistant/welcome")).toEqual({
        action: "redirect",
        to: "/assistant",
      });
      expect(
        guard(s({ isLocalClient: false }), "/assistant/onboarding/hosting"),
      ).toEqual({ action: "redirect", to: "/assistant" });
      expect(
        guard(s({ isLocalClient: false }), "/assistant/onboarding/api-key"),
      ).toEqual({ action: "redirect", to: "/assistant" });
    });

    // The platform build hosts the hub chooser: the route admits a settled
    // authenticated user in every mode.
    test("allows a consented authenticated non-local user on select-assistant", () => {
      expect(guard(s({ isLocalClient: false }), CHOOSER)).toEqual(ALLOW);
    });

    // Opening the chooser to non-local clients does not lift the consent gate
    // that runs after the mode boundary: the route falls through to it like
    // every other platform surface.
    test("sends a stale-consent platform user off select-assistant to review-terms", () => {
      expect(
        guard(
          s({ isLocalClient: false, analyticsConsentCurrent: false }),
          CHOOSER,
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant%2Fselect-assistant",
      });
      expect(
        guard(
          s({
            isLocalClient: false,
            tosAccepted: false,
            privacyConsent: false,
          }),
          CHOOSER,
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant%2Fselect-assistant",
      });
    });

    // The chooser is exempt from the no-assistant funnel: an account whose
    // assistants are all self-hosted has none in `hasAssistants` (remembered
    // origins are client-local), and the funnel would also drop a `?register=`
    // handoff before the chooser could record it.
    test("keeps a zero-assistant platform user on select-assistant", () => {
      expect(guard(s(NO_ASSISTANTS), CHOOSER)).toEqual(ALLOW);
      // Nothing is held for the assistants list here: with no funnel to decide,
      // an unhydrated read has nothing to get wrong.
      expect(
        guard(s({ ...NO_ASSISTANTS, assistantsHydrated: false }), CHOOSER),
      ).toEqual(ALLOW);
    });

    // The exemption lifts the funnel only. Consent runs after it, so terms
    // still gate the chooser for a zero-assistant user.
    test("keeps consent binding on select-assistant with no assistants", () => {
      expect(
        guard(s({ ...NO_ASSISTANTS, analyticsConsentCurrent: false }), CHOOSER),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant%2Fselect-assistant",
      });
      expect(
        guard(
          s({ ...NO_ASSISTANTS, tosAccepted: false, privacyConsent: false }),
          CHOOSER,
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant%2Fselect-assistant",
      });
      // Stale-looking flags that have not hydrated still wait rather than
      // bouncing a consented user off the chooser.
      expect(
        guard(
          s({
            ...NO_ASSISTANTS,
            analyticsConsentCurrent: false,
            consentHydrated: false,
          }),
          CHOOSER,
        ),
      ).toEqual(WAIT);
    });

    // The local chooser is an onboarding surface reachable before there is a
    // session to gate on, so it short-circuits ahead of the assistant and
    // consent gates that bind on the platform hub.
    test("keeps the local chooser open ahead of the consent gate", () => {
      expect(
        guard(
          s({
            isLocalClient: true,
            platformSession: "present",
            analyticsConsentCurrent: false,
          }),
          CHOOSER,
        ),
      ).toEqual(ALLOW);
    });

    test("sends an unauthenticated non-local select-assistant visit to login with returnTo", () => {
      expect(
        guard(s({ isLocalClient: false, isAuthenticated: false }), CHOOSER),
      ).toEqual({
        action: "redirect",
        to: "/account/login?returnTo=%2Fassistant%2Fselect-assistant",
      });
    });

    test("sends an unpaired remote-gateway chooser visit to pairing", () => {
      expect(
        guard(
          s({
            isLocalClient: true,
            isRemoteGateway: true,
            isAuthenticated: false,
          }),
          CHOOSER,
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/pair?returnTo=%2Fassistant%2Fselect-assistant",
      });
    });

    test("allows a gateway-auth remote-gateway chooser visit", () => {
      expect(
        guard(
          s({
            isLocalClient: true,
            isRemoteGateway: true,
            isGatewayAuth: true,
          }),
          CHOOSER,
        ),
      ).toEqual(ALLOW);
    });

    test("allows non-local user on onboarding screens regardless of assistant count", () => {
      expect(
        guard(s({ isLocalClient: false }), "/assistant/onboarding/privacy"),
      ).toEqual(ALLOW);
      expect(
        guard(s({ isLocalClient: false }), "/assistant/onboarding/hatching"),
      ).toEqual(ALLOW);
      expect(
        guard(
          s({ isLocalClient: false, hasAssistants: false }),
          "/assistant/onboarding/privacy",
        ),
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
          s({
            hasAssistants: false,
            tosAccepted: false,
            privacyConsent: false,
          }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("redirects from hatching without consent in local mode", () => {
      expect(
        guard(
          s({ isLocalClient: true, tosAccepted: false, privacyConsent: false }),
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
        guard(
          s({
            isLocalClient: true,
            hasAssistants: false,
            platformSession: "unknown",
          }),
        ),
      ).toEqual(WAIT_FOR_PLATFORM_SESSION);
    });

    test("redirects to hosting when local mode + platform session present", () => {
      expect(
        guard(
          s({
            isLocalClient: true,
            hasAssistants: false,
            platformSession: "present",
          }),
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/hosting" });
    });

    test("redirects to welcome when local mode + no platform session", () => {
      expect(
        guard(
          s({
            isLocalClient: true,
            hasAssistants: false,
            platformSession: "absent",
          }),
        ),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
    });

    test("allows local mode with assistants", () => {
      expect(guard(s({ isLocalClient: true, hasAssistants: true }))).toEqual(
        ALLOW,
      );
    });

    // -- authenticated, platform mode, not onboarded ----------------------

    test("redirects platform-mode user without consent to review-terms with returnTo", () => {
      expect(
        guard(
          s({
            isLocalClient: false,
            tosAccepted: false,
            privacyConsent: false,
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant",
      });
    });

    test("redirects platform-mode user with partial consent to review-terms with returnTo", () => {
      expect(
        guard(
          s({ isLocalClient: false, tosAccepted: true, privacyConsent: false }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant",
      });
    });

    test("redirects platform-mode user without consent and no assistants to privacy, not hatching", () => {
      expect(
        guard(
          s({
            isLocalClient: false,
            tosAccepted: false,
            privacyConsent: false,
            hasAssistants: false,
          }),
        ),
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
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant",
      });
    });

    test("local mode ignores hydration flags (lockfile-driven list, sync consent)", () => {
      // The no-assistants fork keys off the platform probe, not hydration...
      expect(
        guard(
          s({
            isLocalClient: true,
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
            isLocalClient: true,
            hasAssistants: true,
            platformSession: "present",
            tosAccepted: false,
            privacyConsent: false,
            consentHydrated: false,
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant",
      });
    });

    // -- stale consent toggles --------------------------------------------

    test("redirects platform user with current tos/ai but stale analytics toggle to review-terms", () => {
      expect(
        guard(s({ isLocalClient: false, analyticsConsentCurrent: false })),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant",
      });
    });

    test("redirects platform user with stale diagnostics toggle to review-terms", () => {
      expect(
        guard(s({ isLocalClient: false, diagnosticsConsentCurrent: false })),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant",
      });
    });

    test("allows platform user when all four consent flags are current", () => {
      expect(
        guard(
          s({
            isLocalClient: false,
            tosAccepted: true,
            privacyConsent: true,
            analyticsConsentCurrent: true,
            diagnosticsConsentCurrent: true,
          }),
        ),
      ).toEqual(ALLOW);
    });

    test("redirects local-mode user with a platform session and stale consent to review-terms", () => {
      // Consent is gated on the platform session, NOT isLocalClient: a local-mode
      // client logged into the platform still re-reviews stale terms.
      expect(
        guard(
          s({
            isLocalClient: true,
            hasAssistants: true,
            platformSession: "present",
            tosAccepted: false,
            privacyConsent: false,
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant",
      });
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
      expect(guard(s({ hasAssistants: false }), "/assistant/home")).toEqual({
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
        guard(
          s({ hasAssistants: false, diagnosticsConsentCurrent: false }),
          "/assistant/home",
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant%2Fhome",
      });
    });

    // The marketing pricing CTAs deep-link a brand-new (no-assistant) user
    // into `/assistant/checkout` to start Stripe checkout, so that route must
    // NOT be funneled into onboarding — while every other billing surface still
    // is, so a no-assistant user returning to a billing URL provisions first.
    test("does not funnel a consent-settled no-assistant user off /assistant/checkout", () => {
      expect(
        guard(s({ hasAssistants: false }), "/assistant/checkout?package=super"),
      ).toEqual(ALLOW);
    });

    // Checkout is exempt from the no-assistant funnel, NOT from consent: a
    // no-assistant user with a stale consent toggle deep-linking to checkout is
    // routed to review-terms first, never straight into a paid Stripe session.
    test("routes a stale-consent no-assistant user off /assistant/checkout to review-terms", () => {
      expect(
        guard(
          s({ hasAssistants: false, analyticsConsentCurrent: false }),
          "/assistant/checkout?package=super",
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/review-terms?returnTo=%2Fassistant%2Fcheckout%3Fpackage%3Dsuper",
      });
    });

    test("still funnels a no-assistant user returning to a billing URL", () => {
      expect(
        guard(
          s({ hasAssistants: false }),
          "/assistant/settings/usage?tab=billing&session_id=x",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/hatching" });
    });

    // -- post-checkout return with nothing the plan can apply to -----------
    //
    // The marketing pricing funnel has a brand-new user pay BEFORE an
    // assistant exists, and the platform hardcodes the non-native Stripe
    // `success_url` to `/assistant/settings/billing?session_id=…`. Every
    // billing surface mounts under `ActiveAssistantGate`, which spins on
    // "Connecting to your assistant…" forever for a no-assistant org — so the
    // paid return must be funneled into provisioning first.

    const POST_CHECKOUT_BILLING =
      "/assistant/settings/billing?session_id=cs_test_123";

    // Web and Electron land the paid return on the headless research
    // onboarding, which runs the purchased-provisioning wait behind the form.
    const MANAGED_FUNNEL: NavigationDecision = {
      action: "redirect",
      to: RESEARCH_FUNNEL_URL,
    };
    // A brand-new org: nothing resolved at all.
    const EMPTY_ORG = {
      hasAssistants: false,
      hasPlatformHostedAssistant: false,
    } as const;

    // An org whose resolved entries are all local / Docker / another
    // organization's. `hasAssistants` is satisfied; a managed plan still has
    // no target.
    const NO_MANAGED_ASSISTANT = {
      hasAssistants: true,
      hasPlatformHostedAssistant: false,
    } as const;

    test("funnels a no-assistant post-checkout return into the research onboarding", () => {
      expect(guard(s(EMPTY_ORG), POST_CHECKOUT_BILLING)).toEqual(
        MANAGED_FUNNEL,
      );
    });

    // The decision is "does a managed plan have a target", not "is the list
    // empty": in a self-hosted-only org the purchase has nothing to apply to.
    test("funnels a return whose only assistants are self-hosted", () => {
      expect(guard(s(NO_MANAGED_ASSISTANT), POST_CHECKOUT_BILLING)).toEqual(
        MANAGED_FUNNEL,
      );
      expect(
        guard(
          s(NO_MANAGED_ASSISTANT),
          "/assistant/settings/usage?tab=billing&session_id=cs_test_123",
        ),
      ).toEqual(MANAGED_FUNNEL);
    });

    test("leaves an existing-assistant post-checkout return on billing", () => {
      expect(
        guard(s({ hasPlatformHostedAssistant: true }), POST_CHECKOUT_BILLING),
      ).toEqual(ALLOW);
      expect(
        guard(
          s({ hasPlatformHostedAssistant: true }),
          "/assistant/settings/usage?tab=billing&session_id=cs_test_123",
        ),
      ).toEqual(ALLOW);
    });

    // A gateway session normally short-circuits the whole pipeline to "allow",
    // which is exactly how the dead-end is reached in Electron / local-mode
    // web. The paid return is the one path that must still be funneled.
    test("funnels a no-assistant post-checkout return even under gateway auth", () => {
      expect(
        guard(
          s({ isGatewayAuth: true, isLocalClient: true, ...EMPTY_ORG }),
          POST_CHECKOUT_BILLING,
        ),
      ).toEqual(MANAGED_FUNNEL);
    });

    // The Electron desktop case: gateway auth against a local assistant, so
    // `hasAssistants` is true and `requireAssistant` never runs.
    test("funnels a self-hosted-only return under gateway auth", () => {
      expect(
        guard(
          s({
            isGatewayAuth: true,
            isLocalClient: true,
            ...NO_MANAGED_ASSISTANT,
          }),
          POST_CHECKOUT_BILLING,
        ),
      ).toEqual(MANAGED_FUNNEL);
    });

    // A local-mode client is "authenticated" on its gateway session alone, so
    // the platform session is decided separately — and the managed hatch the
    // funnel starts needs one. The probe boots "unknown". The wait names the
    // probe because the org already has an assistant here, so nothing else
    // tells the middleware to await it.
    test("waits for the local-mode platform-session probe before funneling", () => {
      expect(
        guard(
          s({
            isGatewayAuth: true,
            isLocalClient: true,
            platformSession: "unknown",
            ...NO_MANAGED_ASSISTANT,
          }),
          POST_CHECKOUT_BILLING,
        ),
      ).toEqual(WAIT_FOR_PLATFORM_SESSION);
    });

    // Signed out of the platform there is no account to provision into. The
    // return stays on billing, whose login notice carries `session_id` through
    // sign-in and lands back here.
    test("leaves a local-mode return with no platform session on billing", () => {
      expect(
        guard(
          s({
            isGatewayAuth: true,
            isLocalClient: true,
            platformSession: "absent",
            ...NO_MANAGED_ASSISTANT,
          }),
          POST_CHECKOUT_BILLING,
        ),
      ).toEqual(ALLOW);
    });

    test("keeps the gateway-auth bypass for every other case", () => {
      expect(
        guard(
          s({
            isGatewayAuth: true,
            isLocalClient: true,
            hasPlatformHostedAssistant: true,
          }),
          POST_CHECKOUT_BILLING,
        ),
      ).toEqual(ALLOW);
      expect(
        guard(
          s({ isGatewayAuth: true, isLocalClient: true, ...EMPTY_ORG }),
          "/assistant/settings/billing",
        ),
      ).toEqual(ALLOW);
      expect(
        guard(
          s({
            isGatewayAuth: true,
            isLocalClient: true,
            ...NO_MANAGED_ASSISTANT,
          }),
          "/assistant/settings/billing",
        ),
      ).toEqual(ALLOW);
    });

    // A billing URL without `session_id` is not a checkout return, so it keeps
    // whatever `requireAssistant` already decided for it.
    test("leaves a billing URL without session_id on its existing path", () => {
      expect(guard(s(EMPTY_ORG), "/assistant/settings/billing")).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/hatching",
      });
      expect(
        guard(
          s({ ...EMPTY_ORG, tosAccepted: false, privacyConsent: false }),
          "/assistant/settings/billing",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
      // `requireAssistant` reads `hasAssistants`, which the narrower
      // post-checkout predicate must not disturb.
      expect(
        guard(s(NO_MANAGED_ASSISTANT), "/assistant/settings/billing"),
      ).toEqual(ALLOW);
    });

    // Signed out, the return must still reach login with `session_id` intact,
    // so the decision is retaken once the session lands.
    test("sends a signed-out post-checkout return to login with session_id preserved", () => {
      expect(
        guard(
          s({ ...EMPTY_ORG, isAuthenticated: false }),
          POST_CHECKOUT_BILLING,
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/login?returnTo=%2Fassistant%2Fsettings%2Fbilling%3Fsession_id%3Dcs_test_123",
      });
      expect(
        guard(
          s({ ...NO_MANAGED_ASSISTANT, isAuthenticated: false }),
          POST_CHECKOUT_BILLING,
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/login?returnTo=%2Fassistant%2Fsettings%2Fbilling%3Fsession_id%3Dcs_test_123",
      });
    });

    // The platform assistants list boots empty, so deciding before it hydrates
    // would funnel an established user out of their own billing page.
    test("waits for the platform assistants list before funneling", () => {
      expect(
        guard(
          s({ ...EMPTY_ORG, assistantsHydrated: false }),
          POST_CHECKOUT_BILLING,
        ),
      ).toEqual(WAIT);
      expect(
        guard(
          s({ ...NO_MANAGED_ASSISTANT, assistantsHydrated: false }),
          POST_CHECKOUT_BILLING,
        ),
      ).toEqual(WAIT);
    });

    test("does not wait on hydration in local mode (lockfile-driven list)", () => {
      expect(
        guard(
          s({
            isLocalClient: true,
            ...EMPTY_ORG,
            assistantsHydrated: false,
          }),
          POST_CHECKOUT_BILLING,
        ),
      ).toEqual(MANAGED_FUNNEL);
    });

    const UNCONSENTED = { tosAccepted: false, privacyConsent: false } as const;

    // Either toggle going stale forces the same re-review, so the cases below
    // assert against both.
    const STALE_TOGGLES = [
      { analyticsConsentCurrent: false },
      { diagnosticsConsentCurrent: false },
    ] as const;

    // Consent is enforced at the destination, not skipped: both funnel entries
    // are onboarding paths, and re-resolving one bounces an unconsented user on.
    test("consent is still enforced once the funnel destination is resolved", () => {
      expect(
        guard(s({ ...EMPTY_ORG, ...UNCONSENTED }), POST_CHECKOUT_BILLING),
      ).toEqual(MANAGED_FUNNEL);
      for (const url of [RESEARCH_FUNNEL_URL, HATCHING_FUNNEL_URL]) {
        expect(
          redirectPath(guard(s({ ...EMPTY_ORG, ...UNCONSENTED }), url)),
        ).toBe("/assistant/onboarding/privacy");
      }
    });

    // The bounce carries the funnel URL as `returnTo` — the same contract
    // review-terms uses — so the privacy screen resumes it on Start. Dropping
    // it loses the paid-return marker, and the paying user finishes the hatch
    // at the baseline plan. The hatching form round-trips too, because a
    // `returnTo` stashed by an older client names it.
    test("carries the paid funnel destination through the consent bounce", () => {
      expect(
        guard(s({ ...EMPTY_ORG, ...UNCONSENTED }), HATCHING_FUNNEL_URL),
      ).toEqual({
        action: "redirect",
        to: `/assistant/onboarding/privacy?returnTo=${encodeURIComponent(HATCHING_FUNNEL_URL)}`,
      });
    });

    // Only a paid return carries anything: every other hatching bounce is the
    // bare entrypoint it has always been.
    test("an unpaid hatching bounce keeps the bare entrypoint", () => {
      for (const url of [
        "/assistant/onboarding/hatching",
        "/assistant/onboarding/hatching?hosting=vellum-cloud",
        "/assistant/onboarding/hatching?post_checkout=0",
      ]) {
        expect(guard(s(UNCONSENTED), url)).toEqual({
          action: "redirect",
          to: "/assistant/onboarding/privacy",
        });
      }
    });

    // Local mode's onboarding entrypoint is `welcome`, which reads no
    // `returnTo`, so its bounce stays bare.
    test("a local-mode hatching bounce keeps the bare welcome entrypoint", () => {
      expect(
        guard(s({ isLocalClient: true, ...UNCONSENTED }), HATCHING_FUNNEL_URL),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
    });

    // The research route is the headless paid provisioning entry, so it bounces
    // and carries exactly like the hatching entry does.
    test("carries a paid research destination through the consent bounce", () => {
      expect(
        guard(s({ ...EMPTY_ORG, ...UNCONSENTED }), RESEARCH_FUNNEL_URL),
      ).toEqual({
        action: "redirect",
        to: `/assistant/onboarding/privacy?returnTo=${encodeURIComponent(RESEARCH_FUNNEL_URL)}`,
      });
    });

    // The research funnel provisions an assistant, so an unconsented user does
    // not reach it by navigating there directly either.
    test("bounces an unconsented bare research visit to the entrypoint", () => {
      expect(guard(s(UNCONSENTED), "/assistant/onboarding/research")).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
      expect(
        guard(
          s({ isLocalClient: true, ...UNCONSENTED }),
          "/assistant/onboarding/research",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
    });

    test("allows a consented user on the research route", () => {
      expect(guard(s({}), "/assistant/onboarding/research")).toEqual(ALLOW);
      expect(
        guard(s({ hasAssistants: false }), "/assistant/onboarding/research"),
      ).toEqual(ALLOW);
      expect(guard(s({}), RESEARCH_FUNNEL_URL)).toEqual(ALLOW);
    });

    // Onboarding is complete but a toggle went stale: the terms are re-reviewed
    // before the purchased hatch, with the funnel URL (markers intact) as
    // `returnTo` so the plan is not lost on the round trip. The marker is what
    // scopes this — an ordinary research visit keeps its onboarding exemption.
    test("sends a stale-consent paid research return to review-terms", () => {
      for (const stale of STALE_TOGGLES) {
        expect(
          guard(s({ ...EMPTY_ORG, ...stale }), RESEARCH_FUNNEL_URL),
        ).toEqual({
          action: "redirect",
          to: `/assistant/review-terms?returnTo=${encodeURIComponent(RESEARCH_FUNNEL_URL)}`,
        });
        expect(
          guard(
            s({ ...EMPTY_ORG, ...stale }),
            "/assistant/onboarding/research",
          ),
        ).toEqual(ALLOW);
      }
    });

    // A cold paid deep link reaches the research route before the consent flags
    // hydrate, and they boot false — deciding there would bounce an established
    // user to privacy, and a `redirect` gives the auth middleware nothing to
    // wait on.
    test("waits on the research route until consent hydrates", () => {
      for (const url of [
        "/assistant/onboarding/research",
        RESEARCH_FUNNEL_URL,
      ]) {
        expect(
          guard(
            s({ ...EMPTY_ORG, ...UNCONSENTED, consentHydrated: false }),
            url,
          ),
        ).toEqual(WAIT);
        // Same wait for an already-consented user whose flags have not been
        // confirmed yet: hydration is read before the flags either way.
        expect(guard(s({ consentHydrated: false }), url)).toEqual(WAIT);
      }
    });

    // The wait is research-only: the foreground hatching entry is reached from
    // in-app navigation, never a cold deep link, and it bounces immediately.
    test("the hatching bounce does not wait on consent hydration", () => {
      expect(
        guard(
          s({ ...UNCONSENTED, consentHydrated: false }),
          HATCHING_FUNNEL_URL,
        ),
      ).toEqual({
        action: "redirect",
        to: `/assistant/onboarding/privacy?returnTo=${encodeURIComponent(HATCHING_FUNNEL_URL)}`,
      });
    });

    // The auth middleware forces `consentHydrated` once its wait runs out, so
    // the flags underneath are still their boot `false`. Bouncing on them
    // evicts an already-consented user mid-funnel — a paid return loses its
    // markers, a free one restarts onboarding — so the research entry falls
    // back to the unconditional admission it had before it joined the funnel.
    test("admits the research route when consent hydration timed out", () => {
      for (const url of [
        "/assistant/onboarding/research",
        RESEARCH_FUNNEL_URL,
      ]) {
        expect(
          guard(
            s({
              ...EMPTY_ORG,
              ...UNCONSENTED,
              consentHydrated: true,
              consentHydrationTimedOut: true,
            }),
            url,
          ),
        ).toEqual(ALLOW);
      }
      // The stale-toggle gate reads the same unhydrated flags, so it fails open
      // too rather than sending a paid return to review-terms it can't answer.
      expect(
        guard(
          s({
            ...EMPTY_ORG,
            analyticsConsentCurrent: false,
            diagnosticsConsentCurrent: false,
            consentHydrated: true,
            consentHydrationTimedOut: true,
          }),
          RESEARCH_FUNNEL_URL,
        ),
      ).toEqual(ALLOW);
    });

    // Fail-open is scoped to the unhydrated read: a hydration that actually
    // landed on an unconsented user still bounces.
    test("still bounces a genuinely hydrated unconsented research visit", () => {
      expect(
        guard(s({ ...EMPTY_ORG, ...UNCONSENTED }), RESEARCH_FUNNEL_URL),
      ).toEqual({
        action: "redirect",
        to: `/assistant/onboarding/privacy?returnTo=${encodeURIComponent(RESEARCH_FUNNEL_URL)}`,
      });
    });

    // The hatching entry never waits on hydration, so it never sees the forced
    // flag either — its bounce is unchanged by the fail-open.
    test("the hatching bounce is unaffected by a consent hydration timeout", () => {
      expect(
        guard(
          s({
            ...UNCONSENTED,
            consentHydrated: true,
            consentHydrationTimedOut: true,
          }),
          HATCHING_FUNNEL_URL,
        ),
      ).toEqual({
        action: "redirect",
        to: `/assistant/onboarding/privacy?returnTo=${encodeURIComponent(HATCHING_FUNNEL_URL)}`,
      });
    });

    // Local mode is excluded from hydration waits everywhere in the pipeline —
    // its consent hydrates during session init or not at all — so its research
    // bounce decides immediately.
    test("a local-mode research bounce decides without waiting on hydration", () => {
      expect(
        guard(
          s({ isLocalClient: true, ...UNCONSENTED, consentHydrated: false }),
          RESEARCH_FUNNEL_URL,
        ),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
      expect(
        guard(
          s({ isLocalClient: true, ...UNCONSENTED, consentHydrated: false }),
          "/assistant/onboarding/research",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
    });

    // A gateway session short-circuits the pipeline to "allow" before any
    // consent step runs, so the paid funnel entries suspend that bypass —
    // otherwise an Electron paid return starts the purchased hatch with no
    // consent recorded. The Electron desktop shape: gateway auth against a
    // local assistant, with a platform session to provision into.
    const ELECTRON_PAID = {
      isGatewayAuth: true,
      isLocalClient: true,
      platformSession: "present",
      ...NO_MANAGED_ASSISTANT,
    } as const;

    // Local mode's entrypoint is `welcome`, which reads no `returnTo` — the
    // same bare bounce the hatching screen's own gate already gave this user.
    test("bounces an unconsented gateway-auth paid return to the local entrypoint", () => {
      for (const url of [RESEARCH_FUNNEL_URL, HATCHING_FUNNEL_URL]) {
        expect(guard(s({ ...ELECTRON_PAID, ...UNCONSENTED }), url)).toEqual({
          action: "redirect",
          to: "/assistant/welcome",
        });
      }
    });

    // Suspending the bypass must not bounce a consented paid return: it is the
    // whole point of the funnel that it reaches the hatch.
    test("allows a consented gateway-auth paid return", () => {
      for (const url of [RESEARCH_FUNNEL_URL, HATCHING_FUNNEL_URL]) {
        expect(guard(s(ELECTRON_PAID), url)).toEqual(ALLOW);
      }
    });

    // Onboarding is complete but a toggle went stale, so the terms are
    // re-reviewed before the purchased hatch — with the funnel URL as
    // `returnTo`, so the markers survive and the plan is not lost.
    test("sends a stale-consent gateway-auth paid research return to review-terms", () => {
      for (const stale of STALE_TOGGLES) {
        expect(
          guard(s({ ...ELECTRON_PAID, ...stale }), RESEARCH_FUNNEL_URL),
        ).toEqual({
          action: "redirect",
          to: `/assistant/review-terms?returnTo=${encodeURIComponent(RESEARCH_FUNNEL_URL)}`,
        });
      }
    });

    // The stale-toggle gate is research-only. The hatching entry — where a
    // `returnTo` stashed by an older client may still point — resolves `allow`
    // here and re-reviews stale terms at the screen's own `hatch-gate` instead.
    test("leaves a stale-consent paid hatching return on its allow", () => {
      for (const stale of STALE_TOGGLES) {
        expect(
          guard(s({ ...ELECTRON_PAID, ...stale }), HATCHING_FUNNEL_URL),
        ).toEqual(ALLOW);
        expect(
          guard(s({ ...EMPTY_ORG, ...stale }), HATCHING_FUNNEL_URL),
        ).toEqual(ALLOW);
      }
    });

    // Only the paid marker suspends the bypass. The local adopt flow reaches
    // the research entry unmarked and keeps the bypass it has always had.
    test("keeps the gateway-auth bypass on an unmarked funnel entry", () => {
      for (const url of [
        "/assistant/onboarding/research",
        "/assistant/onboarding/research?hosting=vellum-cloud",
        "/assistant/onboarding/hatching",
        "/assistant/onboarding/hatching?post_checkout=0",
      ]) {
        expect(guard(s({ ...ELECTRON_PAID, ...UNCONSENTED }), url)).toEqual(
          ALLOW,
        );
      }
    });

    // A remote-gateway session is gateway auth too. Paired (authenticated), it
    // passes the pairing step untouched; unpaired it pairs first, and the
    // pairing `returnTo` keeps the markers so the funnel resumes after.
    test("leaves remote-gateway pairing intact on a paid funnel entry", () => {
      expect(
        guard(
          s({ ...ELECTRON_PAID, isRemoteGateway: true }),
          RESEARCH_FUNNEL_URL,
        ),
      ).toEqual(ALLOW);
      expect(
        guard(
          s({
            ...ELECTRON_PAID,
            isRemoteGateway: true,
            isAuthenticated: false,
          }),
          RESEARCH_FUNNEL_URL,
        ),
      ).toEqual({
        action: "redirect",
        to: `/assistant/pair?returnTo=${encodeURIComponent(RESEARCH_FUNNEL_URL)}`,
      });
    });

    // The funnel destination must not itself read as a checkout return, or the
    // redirect would loop.
    test("the funnel destination is not treated as a post-checkout return", () => {
      for (const url of [
        "/assistant/onboarding/hatching?session_id=cs_test_123",
        "/assistant/onboarding/research?session_id=cs_test_123",
      ]) {
        expect(guard(s(EMPTY_ORG), url)).toEqual(ALLOW);
      }
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
      resolveNavigation(state, {
        kind: "onboarding-intercept",
        intendedDestination: dest,
      });

    test("allows local mode with assistants", () => {
      expect(
        intercept(
          s({ isLocalClient: true, hasAssistants: true }),
          "/assistant",
        ),
      ).toEqual(ALLOW);
    });

    test("allows when tos and consent accepted", () => {
      expect(
        intercept(s({ tosAccepted: true, privacyConsent: true }), "/assistant"),
      ).toEqual(ALLOW);
    });

    test("allows an already-onboarded assistant even without local consent flags", () => {
      expect(
        intercept(
          s({
            alreadyOnboarded: true,
            tosAccepted: false,
            privacyConsent: false,
          }),
          "/assistant",
        ),
      ).toEqual(ALLOW);
    });

    test("stale toggles do not change onboarding-intercept (hasCompletedOnboarding only)", () => {
      expect(
        intercept(
          s({
            analyticsConsentCurrent: false,
            diagnosticsConsentCurrent: false,
          }),
          "/assistant",
        ),
      ).toEqual(ALLOW);
    });

    test("allows destination outside /assistant", () => {
      expect(
        intercept(
          s({ tosAccepted: false, privacyConsent: false }),
          "/account/login",
        ),
      ).toEqual(ALLOW);
    });

    test("allows destination in /assistant/onboarding", () => {
      expect(
        intercept(
          s({ tosAccepted: false, privacyConsent: false }),
          "/assistant/onboarding/privacy",
        ),
      ).toEqual(ALLOW);
    });

    test("redirects to welcome in local mode", () => {
      expect(
        intercept(
          s({
            isLocalClient: true,
            hasAssistants: false,
            tosAccepted: false,
            privacyConsent: false,
          }),
          "/assistant",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
    });

    test("redirects to privacy in platform mode", () => {
      expect(
        intercept(
          s({ tosAccepted: false, privacyConsent: false }),
          "/assistant",
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
    });

    test("handles absolute URL destinations", () => {
      expect(
        intercept(
          s({ tosAccepted: false, privacyConsent: false }),
          "https://assistant.vellum.ai/assistant",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("handles protocol-relative URL destinations", () => {
      expect(
        intercept(
          s({ tosAccepted: false, privacyConsent: false }),
          "//assistant.vellum.ai/assistant",
        ),
      ).toEqual({ action: "redirect", to: "/assistant/onboarding/privacy" });
    });

    test("allows absolute URL outside /assistant", () => {
      expect(
        intercept(
          s({ tosAccepted: false, privacyConsent: false }),
          "https://vellum.ai/account",
        ),
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
      expect(hatch(s({ isAuthenticated: false, isLocalClient: false }))).toEqual({
        action: "redirect",
        to: "/account/login",
      });
    });

    test("redirects unauthenticated local-mode user without consent to welcome", () => {
      expect(
        hatch(
          s({
            isAuthenticated: false,
            isLocalClient: true,
            tosAccepted: false,
            privacyConsent: false,
          }),
        ),
      ).toEqual({
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
        hatch(
          s({ isLocalClient: true, tosAccepted: false, privacyConsent: false }),
        ),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
    });

    test("allows with full consent", () => {
      expect(hatch(s({ tosAccepted: true, privacyConsent: true }))).toEqual(
        ALLOW,
      );
    });

    test("redirects platform user with stale analytics toggle to review-terms", () => {
      expect(hatch(s({ analyticsConsentCurrent: false }))).toEqual({
        action: "redirect",
        to: "/assistant/review-terms",
      });
    });

    test("redirects platform user with stale diagnostics toggle to review-terms", () => {
      expect(hatch(s({ diagnosticsConsentCurrent: false }))).toEqual({
        action: "redirect",
        to: "/assistant/review-terms",
      });
    });

    test("does not gate local-mode user on stale toggles", () => {
      expect(
        hatch(
          s({
            isLocalClient: true,
            analyticsConsentCurrent: false,
            diagnosticsConsentCurrent: false,
          }),
        ),
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
      expect(
        postRetire(s({ hasAssistants: true, isLocalClient: true })),
      ).toEqual({
        action: "redirect",
        to: "/assistant/select-assistant",
      });
    });

    test("redirects to /assistant in platform mode when other assistants remain", () => {
      expect(
        postRetire(s({ hasAssistants: true, isLocalClient: false })),
      ).toEqual({
        action: "redirect",
        to: "/assistant",
      });
    });

    test("redirects to privacy in platform mode when no assistants remain", () => {
      expect(
        postRetire(s({ hasAssistants: false, isLocalClient: false })),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
    });

    test("redirects to hosting in local mode when platform session present", () => {
      expect(
        postRetire(
          s({
            hasAssistants: false,
            isLocalClient: true,
            platformSession: "present",
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/hosting",
      });
    });

    test("redirects to welcome in local mode when no platform session", () => {
      expect(
        postRetire(
          s({
            hasAssistants: false,
            isLocalClient: true,
            platformSession: "absent",
          }),
        ),
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
    beforeEach(() => {
      sessionStorage.clear();
      // Reset the module-level in-memory mirror so a stash set by one case
      // can't leak into the next through the sessionStorage fallback.
      clearCheckoutIntent();
    });

    const postAuth = (
      authIntent: "login" | "signup",
      returnTo: string | null,
      fallback = "/assistant",
    ) =>
      resolveNavigation(base, {
        kind: "post-auth",
        authIntent,
        returnTo,
        fallback,
      });

    test("signup goes to privacy for non-import returnTo", () => {
      expect(postAuth("signup", "/some-return")).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
      // A non-checkout signup stashes no checkout intent.
      expect(readCheckoutIntent()).toBeNull();
    });

    test("signup via the checkout deep link still routes through consent but stashes the package", () => {
      expect(postAuth("signup", "/assistant/checkout?package=super")).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
      expect(readCheckoutIntent()).toMatchObject({
        kind: "package",
        packageKey: "super",
      });
    });

    test("signup via checkout without a package stashes nothing", () => {
      expect(postAuth("signup", "/assistant/checkout")).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
      expect(readCheckoutIntent()).toBeNull();
    });

    test("login via the checkout deep link returns there directly and stashes nothing", () => {
      expect(postAuth("login", "/assistant/checkout?package=super")).toEqual({
        action: "redirect",
        to: "/assistant/checkout?package=super",
      });
      expect(readCheckoutIntent()).toBeNull();
    });

    test("signup goes to privacy without returnTo", () => {
      expect(postAuth("signup", null)).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
    });

    test("signup honors an import-funnel returnTo, query preserved", () => {
      expect(
        postAuth("signup", "/import?utm_source=hermes&import=hermes"),
      ).toEqual({
        action: "redirect",
        to: "/import?utm_source=hermes&import=hermes",
      });
      expect(postAuth("signup", "/import")).toEqual({
        action: "redirect",
        to: "/import",
      });
    });

    test("signup does not treat import-prefixed pages as the funnel", () => {
      expect(postAuth("signup", "/importantly-not-the-funnel")).toEqual({
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

    test("signup skips privacy when the assistant is already onboarded", () => {
      expect(
        resolveNavigation(s({ alreadyOnboarded: true }), {
          kind: "post-auth",
          authIntent: "signup",
          returnTo: "/assistant/home",
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: "/assistant/home" });
      expect(readCheckoutIntent()).toBeNull();
    });

    test("signup with a checkout deep link skips privacy when already onboarded", () => {
      expect(
        resolveNavigation(s({ alreadyOnboarded: true }), {
          kind: "post-auth",
          authIntent: "signup",
          returnTo: "/assistant/checkout?package=super",
          fallback: "/assistant",
        }),
      ).toEqual({
        action: "redirect",
        to: "/assistant/checkout?package=super",
      });
      expect(readCheckoutIntent()).toBeNull();
    });

    test("login keeps a paid hatch returnTo when already onboarded", () => {
      expect(
        resolveNavigation(s({ alreadyOnboarded: true }), {
          kind: "post-auth",
          authIntent: "login",
          returnTo: HATCHING_FUNNEL_URL,
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: HATCHING_FUNNEL_URL });
    });

    test("login skips a privacy or research returnTo when already onboarded", () => {
      expect(
        resolveNavigation(s({ alreadyOnboarded: true }), {
          kind: "post-auth",
          authIntent: "login",
          returnTo: "/assistant/onboarding/privacy",
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: "/assistant" });
      expect(
        resolveNavigation(s({ alreadyOnboarded: true }), {
          kind: "post-auth",
          authIntent: "login",
          returnTo: "/assistant/onboarding/research?hosting=vellum-cloud",
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: "/assistant" });
    });

    test("signup still goes to privacy for a freshly hatched assistant", () => {
      expect(
        resolveNavigation(s({ alreadyOnboarded: false, hasAssistants: true }), {
          kind: "post-auth",
          authIntent: "signup",
          returnTo: "/assistant/home",
          fallback: "/assistant",
        }),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
    });

    test("a non-checkout signup clears a stale stash from an abandoned attempt", () => {
      saveCheckoutIntent({ kind: "package", packageKey: "abandoned" });
      expect(postAuth("signup", "/some-return")).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/privacy",
      });
      expect(readCheckoutIntent()).toBeNull();
    });

    test("a non-checkout login clears a stale stash from an abandoned attempt", () => {
      saveCheckoutIntent({ kind: "package", packageKey: "abandoned" });
      expect(postAuth("login", "/assistant/home")).toEqual({
        action: "redirect",
        to: "/assistant/home",
      });
      expect(readCheckoutIntent()).toBeNull();
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
        resolveLoginReturnTo(
          s({ hasAssistants: false }),
          "/assistant/onboarding/hosting",
        ),
      ).toBe("/assistant/onboarding/hosting");
    });

    test("appends fromLogin param when logging in from select-assistant", () => {
      expect(resolveLoginReturnTo(s({}), "/assistant/select-assistant")).toBe(
        "/assistant/select-assistant?fromLogin=1",
      );
    });

    test("returns the same path for other non-welcome pages", () => {
      expect(resolveLoginReturnTo(s({}), "/assistant/onboarding/hosting")).toBe(
        "/assistant/onboarding/hosting",
      );
    });
  });

  // -----------------------------------------------------------------------
  // postCheckoutHatchReturnTo
  // -----------------------------------------------------------------------
  describe("postCheckoutHatchReturnTo", () => {
    test("accepts the headless research funnel entry", () => {
      expect(postCheckoutHatchReturnTo(RESEARCH_FUNNEL_URL)).toBe(
        RESEARCH_FUNNEL_URL,
      );
    });

    // A `returnTo` stashed on the privacy screen by an older client names the
    // hatching entry; it must still resume rather than drop the paid markers.
    test("accepts the foreground hatching funnel entry", () => {
      expect(postCheckoutHatchReturnTo(HATCHING_FUNNEL_URL)).toBe(
        HATCHING_FUNNEL_URL,
      );
    });

    test("rejects any other path, even carrying the marker", () => {
      for (const url of [
        "/assistant/onboarding/privacy?post_checkout=1",
        "/assistant/settings/billing?post_checkout=1",
        "/assistant?post_checkout=1",
        "/assistant/onboarding/research-mock?post_checkout=1",
      ]) {
        expect(postCheckoutHatchReturnTo(url)).toBeNull();
      }
    });

    test("rejects a funnel path without the paid marker", () => {
      for (const url of [
        "/assistant/onboarding/research",
        "/assistant/onboarding/research?hosting=vellum-cloud",
        "/assistant/onboarding/research?post_checkout=0",
        "/assistant/onboarding/hatching",
        "/assistant/onboarding/hatching?hosting=vellum-cloud",
      ]) {
        expect(postCheckoutHatchReturnTo(url)).toBeNull();
      }
    });

    test("rejects absolute and protocol-relative URLs", () => {
      for (const url of [
        "https://evil.example.com/assistant/onboarding/research?post_checkout=1",
        "//evil.example.com/assistant/onboarding/research?post_checkout=1",
        "http://localhost/assistant/onboarding/hatching?post_checkout=1",
      ]) {
        expect(postCheckoutHatchReturnTo(url)).toBeNull();
      }
    });

    test("rejects absent values", () => {
      expect(postCheckoutHatchReturnTo(null)).toBeNull();
      expect(postCheckoutHatchReturnTo(undefined)).toBeNull();
      expect(postCheckoutHatchReturnTo("")).toBeNull();
    });
  });
});
