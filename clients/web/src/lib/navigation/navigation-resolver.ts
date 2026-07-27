import type { PlatformSessionStatus } from "@/stores/session-status";
import { sanitizeReturnTo } from "@/domains/account/return-to";
import { resolveSignupCheckoutDestination } from "@/lib/billing/post-auth-checkout";
import { routes } from "@/utils/routes";

// ---------------------------------------------------------------------------
// State — every variable that can influence a routing decision
// ---------------------------------------------------------------------------

export interface NavigationState {
  isLocalMode: boolean;
  isPlatformDisabled: boolean;
  isRemoteGateway: boolean;
  remoteGatewayPublicPathPrefix: string;
  isGatewayAuth: boolean;
  hasAssistants: boolean;
  /**
   * Whether the active organization has a **platform-hosted** assistant — the
   * only kind a managed plan can apply to.
   *
   * Strictly narrower than `hasAssistants`, which counts every resolved entry
   * regardless of hosting or owning org: a local, Docker, or
   * other-organization assistant satisfies `hasAssistants` while leaving this
   * org with nothing the purchased plan can be applied to.
   */
  hasPlatformHostedAssistant: boolean;
  sessionSettled: boolean;
  isAuthenticated: boolean;
  platformSession: PlatformSessionStatus;
  tosAccepted: boolean;
  privacyConsent: boolean;
  analyticsConsentCurrent: boolean;
  diagnosticsConsentCurrent: boolean;
  /**
   * Whether the consent flags above reflect a completed session sync (or an
   * explicit acceptance). They boot `false`, so acting on them before
   * hydration would misread an established user as un-onboarded.
   */
  consentHydrated: boolean;
  /** Whether the resolved assistants list reflects at least one authoritative load. */
  assistantsHydrated: boolean;
}

// ---------------------------------------------------------------------------
// Query — what the caller wants to know
// ---------------------------------------------------------------------------

export type NavigationQuery =
  | { kind: "route-guard"; pathname: string }
  | { kind: "onboarding-intercept"; intendedDestination: string }
  | { kind: "hatch-gate" }
  | {
      kind: "post-auth";
      authIntent: "login" | "signup";
      returnTo: string | null;
      fallback: string;
    }
  | { kind: "post-retire" };

// ---------------------------------------------------------------------------
// Decision — what the caller should do
// ---------------------------------------------------------------------------

export type NavigationDecision =
  | { action: "allow" }
  | { action: "redirect"; to: string }
  /**
   * State the decision depends on has not settled yet.
   *
   * `waitFor` names the signal when it is one the caller has to block on
   * beyond the session itself, so a caller that can await it (the auth
   * middleware) awaits exactly that signal instead of guessing from the
   * surrounding state — guessing wrong re-resolves on unchanged state and
   * spins.
   */
  | { action: "wait"; waitFor?: "platform-session" };

// ---------------------------------------------------------------------------
// Shared predicates & helpers
// ---------------------------------------------------------------------------

function hasCompletedOnboarding(state: NavigationState): boolean {
  return state.tosAccepted && state.privacyConsent;
}

/**
 * Onboarding is complete AND every consent toggle is for the current version.
 * A stale toggle means the user must re-review the terms even though they
 * already finished onboarding.
 */
function consentIsCurrent(state: NavigationState): boolean {
  return (
    hasCompletedOnboarding(state) &&
    state.analyticsConsentCurrent &&
    state.diagnosticsConsentCurrent
  );
}

const ONBOARDING_PREFIX = `${routes.assistant}/onboarding`;

const LOCAL_ONLY_ONBOARDING_PATHS: Set<string> = new Set([
  routes.onboarding.hosting,
  routes.onboarding.apiKey,
]);

const LOCAL_ONLY_STANDALONE_PATHS: Set<string> = new Set([
  routes.welcome,
  routes.selectAssistant,
]);

function isOnboardingPath(pathname: string): boolean {
  return pathname.startsWith(`${ONBOARDING_PREFIX}/`) || pathname === ONBOARDING_PREFIX;
}

function onboardingEntrypoint(isLocalMode: boolean): string {
  return isLocalMode ? routes.welcome : routes.onboarding.privacy;
}

/**
 * The two paths a finished Stripe Checkout can land on: the platform's
 * hardcoded non-native `success_url` (`/assistant/settings/billing`, which
 * `BillingRedirectPage` forwards) and the Billing tab's own path, which the
 * native deep-link return and `usageBillingCheckout()` build directly.
 */
const POST_CHECKOUT_LANDING_PATHS: Set<string> = new Set([
  `${routes.settings.root}/billing`,
  routes.settings.usage,
]);

/** Whether `pathnameWithSearch` is a billing landing carrying Stripe's `session_id`. */
function isPostCheckoutReturn(
  path: string,
  pathnameWithSearch: string,
): boolean {
  if (!POST_CHECKOUT_LANDING_PATHS.has(path)) {
    return false;
  }
  const qIdx = pathnameWithSearch.indexOf("?");
  if (qIdx < 0) {
    return false;
  }
  return new URLSearchParams(pathnameWithSearch.slice(qIdx + 1)).has(
    "session_id",
  );
}

/**
 * The hatching-screen query param naming a hatch that is the return leg of a
 * completed Stripe Checkout. Only {@link MANAGED_PROVISIONING_DESTINATION} sets
 * it, and only for a billing landing carrying Stripe's `session_id`.
 *
 * Deliberately separate from `hosting=vellum-cloud`, which says only that the
 * hatch is managed — a hosting choice a free user can make too. The hatching
 * screen holds for a lagging subscription webhook on this param alone, so
 * conflating the two would park every free managed hatch on a spinner.
 */
export const POST_CHECKOUT_HATCH_PARAM = "post_checkout";

/**
 * The provisioning funnel entry for a purchase with no managed assistant to
 * apply to.
 *
 * `hosting=vellum-cloud` is the onboarding flow's managed-hatch marker (see
 * `adopt-existing-assistant`): it names a managed hatch even in a local-mode
 * build, where the hatching screen would otherwise let the local gateway answer
 * for the assistant and skip the purchased-provisioning wait.
 *
 * {@link POST_CHECKOUT_HATCH_PARAM} adds the narrower fact that money has
 * already changed hands, which is what lets the hatching screen treat a
 * still-base subscription read as a pending webhook rather than a free org.
 */
const MANAGED_PROVISIONING_DESTINATION = `${routes.onboarding.hatching}?hosting=vellum-cloud&${POST_CHECKOUT_HATCH_PARAM}=1`;

/**
 * `value` when it names a paid managed hatch, else `null`.
 *
 * Narrower than {@link sanitizeReturnTo}'s open-redirect check: the onboarding
 * privacy screen navigates here in place of the standard onboarding step once
 * consent is recorded, so admitting any same-origin path would let a crafted
 * link skip the rest of the funnel. Only the hatching route carrying
 * {@link POST_CHECKOUT_HATCH_PARAM} qualifies, which only
 * {@link MANAGED_PROVISIONING_DESTINATION} produces.
 */
export function postCheckoutHatchReturnTo(
  value: string | null | undefined,
): string | null {
  const destination = sanitizeReturnTo(value, "");
  if (!destination.startsWith("/")) {
    return null;
  }
  const qIdx = destination.indexOf("?");
  if (qIdx < 0 || destination.slice(0, qIdx) !== routes.onboarding.hatching) {
    return null;
  }
  const params = new URLSearchParams(destination.slice(qIdx + 1));
  if (params.get(POST_CHECKOUT_HATCH_PARAM) !== "1") {
    return null;
  }
  return destination;
}

function extractPathname(destination: string): string {
  if (
    destination.startsWith("http://") ||
    destination.startsWith("https://") ||
    destination.startsWith("//")
  ) {
    try {
      return new URL(destination, "http://placeholder.invalid").pathname;
    } catch {
      return destination;
    }
  }
  return destination;
}

// ---------------------------------------------------------------------------
// Login return-to
// ---------------------------------------------------------------------------

export function resolveLoginReturnTo(
  state: NavigationState,
  fromPath: string,
): string {
  if (fromPath === routes.welcome) {
    return state.hasAssistants
      ? routes.selectAssistant
      : routes.onboarding.hosting;
  }
  if (fromPath === routes.selectAssistant) {
    return `${fromPath}?fromLogin=1`;
  }
  return fromPath;
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

export function resolveNavigation(
  state: NavigationState,
  query: NavigationQuery,
): NavigationDecision {
  switch (query.kind) {
    case "route-guard":
      return resolveRouteGuard(state, query.pathname);
    case "onboarding-intercept":
      return resolveOnboardingIntercept(state, query.intendedDestination);
    case "hatch-gate":
      return resolveHatchGate(state);
    case "post-auth":
      return resolvePostAuth(query.authIntent, query.returnTo, query.fallback);
    case "post-retire":
      return resolvePostRetire(state);
  }
}

// ---------------------------------------------------------------------------
// Route guard — pipeline of steps
// ---------------------------------------------------------------------------
//
// Each step returns a NavigationDecision to short-circuit, or null to
// pass through to the next step. The pipeline terminates with "allow".
//
// Conceptual layers:
//   1. Readiness          — is the session ready?
//   2. Paid return        — a checkout return with nothing provisioned yet
//   3. Bypass             — gateway auth skips everything
//   4. Identity           — is the user authenticated?
//   5. Mode boundary      — is this path valid for the user's mode?
//   6. Setup exemptions   — onboarding/consent paths are always reachable
//   7. Assistant required  — user needs at least one assistant
//   8. Consent required   — platform users must accept TOS

type RouteGuardStep = (
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
) => NavigationDecision | null;

const ROUTE_GUARD_PIPELINE: RouteGuardStep[] = [
  waitForSession,
  requirePostCheckoutProvisioning,
  allowGatewayAuth,
  requireRemoteGatewayPairing,
  requireAuth,
  enforceModeBoundary,
  allowSetupRoutes,
  requireAssistant,
  requireConsent,
];

function resolveRouteGuard(
  state: NavigationState,
  pathnameWithSearch: string,
): NavigationDecision {
  const qIdx = pathnameWithSearch.indexOf("?");
  const path = qIdx >= 0 ? pathnameWithSearch.slice(0, qIdx) : pathnameWithSearch;

  for (const step of ROUTE_GUARD_PIPELINE) {
    const decision = step(state, path, pathnameWithSearch);
    if (decision) return decision;
  }
  return { action: "allow" };
}

function waitForSession(state: NavigationState): NavigationDecision | null {
  return state.sessionSettled ? null : { action: "wait" };
}

/**
 * A finished Stripe Checkout returning to an org with nothing the purchased
 * plan can apply to.
 *
 * The marketing pricing funnel has a brand-new user pay BEFORE anything is
 * provisioned, and the platform hardcodes the non-native `success_url` to the
 * billing landing. Every billing surface mounts under `ActiveAssistantGate`,
 * which renders a "Connecting to your assistant…" placeholder for as long as
 * no assistant resolves — so the paid return dead-ends on a spinner. Send it
 * into the hatching funnel instead, which provisions the assistant and applies
 * the purchased specs.
 *
 * The destination is {@link MANAGED_PROVISIONING_DESTINATION}: the marker is
 * what makes a local-mode client provision on the platform and hold for the
 * purchased machine and storage instead of letting its own gateway answer for
 * the assistant.
 *
 * The decision is `hasPlatformHostedAssistant`, not `hasAssistants`: a managed
 * plan is only expressible on a platform-hosted assistant, so an org whose
 * only entries are local, Docker, or another organization's needs the same
 * provisioning funnel. Hatching is additive — the lockfile keeps every
 * existing entry and they stay reachable from the assistant switcher — so a
 * self-hosted user who buys managed hosting ends up holding both.
 *
 * The predicate is org membership rather than the active assistant because the
 * purchase applies to the org: `BillingTab` opens the org-scoped pro onboarding
 * wizard on `session_id` whichever assistant is selected, and hatching a second
 * managed assistant for an org that already has one provisions a machine nobody
 * bought.
 *
 * `session_id` is deliberately dropped: the hatch reads the purchased ceiling
 * from the subscription server-side (`awaitPurchasedProvisioning`), so nothing
 * downstream of this redirect consumes the Stripe session. Credit top-ups
 * return with `billing_status`, never `session_id`, so they never reach here.
 *
 * Runs before `allowGatewayAuth` because that step short-circuits the whole
 * pipeline to "allow" for a gateway session — which is how the dead-end is
 * reached in Electron / local-mode web, where `requireAssistant` never runs.
 * Electron takes the `"native"` checkout return, but its deep-link handler
 * lands on the same in-app billing path carrying `session_id`, so it resolves
 * through this pipeline too.
 * Consent is still enforced: the destination is an onboarding path, and
 * `onboardingCompletedMiddleware` re-runs this pipeline there, where
 * `allowSetupRoutes` bounces an unconsented user to the privacy screen.
 */
function requirePostCheckoutProvisioning(
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  // An org with a platform-hosted assistant has a target for the purchase, so
  // the return stays on billing and the pro onboarding wizard consumes
  // `session_id` there.
  if (state.hasPlatformHostedAssistant) {
    return null;
  }
  if (!isPostCheckoutReturn(path, pathnameWithSearch)) {
    return null;
  }
  // Not signed in yet: fall through so `requireAuth` sends the user to login
  // with a `returnTo` that still carries `session_id`, and this step decides
  // again on the way back.
  if (!state.isAuthenticated) {
    return null;
  }
  // The platform assistants list boots empty and loads asynchronously, so
  // deciding on that default would funnel an established user out of their own
  // billing page. Local mode is excluded for the same reason as in
  // `requireAssistant` — its list is lockfile-driven.
  if (!state.isLocalMode && !state.assistantsHydrated) {
    return { action: "wait" };
  }
  // A local-mode client reaches "authenticated" on its gateway session alone,
  // so the platform session is a separate question — and the managed hatch this
  // redirect starts needs one for the org header and the purchased ceiling. The
  // probe boots `"unknown"`, so hold until it settles. When it settles absent
  // there is no account to provision into: fall through to billing, whose login
  // notice carries `session_id` through sign-in and lands back here.
  if (state.isLocalMode) {
    if (state.platformSession === "unknown") {
      return { action: "wait", waitFor: "platform-session" };
    }
    if (state.platformSession !== "present") {
      return null;
    }
  }
  return { action: "redirect", to: MANAGED_PROVISIONING_DESTINATION };
}

function allowGatewayAuth(state: NavigationState): NavigationDecision | null {
  return state.isGatewayAuth ? { action: "allow" } : null;
}

function stripRemoteGatewayPublicPathPrefix(
  state: NavigationState,
  pathnameWithSearch: string,
): string {
  const prefix = state.remoteGatewayPublicPathPrefix;
  if (!state.isRemoteGateway || !prefix) return pathnameWithSearch;
  if (pathnameWithSearch === prefix) return routes.assistant;
  if (pathnameWithSearch.startsWith(`${prefix}/`)) {
    return pathnameWithSearch.slice(prefix.length);
  }
  return pathnameWithSearch;
}

function requireRemoteGatewayPairing(
  state: NavigationState,
  _path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  if (!state.isRemoteGateway || state.isAuthenticated) return null;

  const returnTo = stripRemoteGatewayPublicPathPrefix(state, pathnameWithSearch);
  return {
    action: "redirect",
    to: `${routes.remotePair}?returnTo=${encodeURIComponent(returnTo)}`,
  };
}

function requireAuth(
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  if (state.isAuthenticated) return null;

  if (state.isLocalMode && (isOnboardingPath(path) || LOCAL_ONLY_STANDALONE_PATHS.has(path))) {
    if (path === routes.selectAssistant && !state.hasAssistants) {
      return { action: "redirect", to: routes.onboarding.hosting };
    }
    return { action: "allow" };
  }
  if (state.isLocalMode && !state.hasAssistants) {
    return { action: "redirect", to: routes.welcome };
  }
  if (state.isLocalMode) {
    return { action: "redirect", to: routes.selectAssistant };
  }
  return {
    action: "redirect",
    to: `${routes.account.login}?returnTo=${encodeURIComponent(pathnameWithSearch)}`,
  };
}

function enforceModeBoundary(
  state: NavigationState,
  path: string,
): NavigationDecision | null {
  if (LOCAL_ONLY_STANDALONE_PATHS.has(path)) {
    if (!state.isLocalMode) {
      return { action: "redirect", to: routes.assistant };
    }
    if (path === routes.selectAssistant && !state.hasAssistants) {
      return { action: "redirect", to: routes.onboarding.hosting };
    }
    return { action: "allow" };
  }

  if (LOCAL_ONLY_ONBOARDING_PATHS.has(path) && !state.isLocalMode) {
    return { action: "redirect", to: routes.assistant };
  }

  return null;
}

/**
 * Where an unconsented user who reached the hatching screen is sent.
 *
 * A paid return carries its hatching URL as `returnTo`, the same contract
 * `review-terms` uses, and the privacy screen resumes it on Start. Without the
 * carry the funnel's markers are lost on the bounce and the paying user
 * finishes the hatch at the baseline plan. Every other hatching bounce — and
 * local mode, whose entrypoint is `welcome` and reads no `returnTo` — gets the
 * bare entrypoint.
 */
function consentBounceDestination(
  state: NavigationState,
  pathnameWithSearch: string,
): string {
  const entrypoint = onboardingEntrypoint(state.isLocalMode);
  if (entrypoint !== routes.onboarding.privacy) {
    return entrypoint;
  }
  const paidReturn = postCheckoutHatchReturnTo(pathnameWithSearch);
  if (!paidReturn) {
    return entrypoint;
  }
  return `${entrypoint}?returnTo=${encodeURIComponent(paidReturn)}`;
}

function allowSetupRoutes(
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  if (path === routes.reviewTerms) {
    return { action: "allow" };
  }

  if (isOnboardingPath(path)) {
    if (path === routes.onboarding.hatching && !hasCompletedOnboarding(state)) {
      return {
        action: "redirect",
        to: consentBounceDestination(state, pathnameWithSearch),
      };
    }
    return { action: "allow" };
  }

  return null;
}

function requireAssistant(
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  if (state.hasAssistants) return null;

  // The marketing pricing CTAs deep-link a brand-new user (no assistant yet)
  // straight into Stripe checkout for a chosen package. Exempt that route from
  // the no-assistant funnel redirect only here — `requireConsent` runs after
  // this step, so consent is still enforced before any paid checkout starts.
  // Every other billing surface still funnels a no-assistant user into
  // provisioning first.
  if (path === routes.checkout) return null;

  if (state.isLocalMode) {
    if (state.platformSession === "unknown") {
      return { action: "wait", waitFor: "platform-session" };
    }
    if (state.platformSession === "present") {
      return { action: "redirect", to: routes.onboarding.hosting };
    }
    return { action: "redirect", to: routes.welcome };
  }

  // Platform boot populates the assistants list and the consent flags
  // asynchronously; both boot empty/false. Deciding before they hydrate would
  // read an established user as brand-new and funnel them into onboarding.
  // (Local mode is excluded above — its list is lockfile-driven.)
  if (!state.assistantsHydrated || !state.consentHydrated) {
    return { action: "wait" };
  }

  if (!hasCompletedOnboarding(state)) {
    return { action: "redirect", to: routes.onboarding.privacy };
  }
  // A stale toggle must be re-reviewed before provisioning an assistant.
  if (!consentIsCurrent(state)) {
    const returnTo = encodeURIComponent(pathnameWithSearch);
    return { action: "redirect", to: `${routes.reviewTerms}?returnTo=${returnTo}` };
  }
  // A consented user with no assistant goes to the standard hatching screen.
  return { action: "redirect", to: routes.onboarding.hatching };
}

function requireConsent(
  state: NavigationState,
  _path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  // Consent is a platform-account concern: only enforce it when there is a
  // live platform session to consent against. A disabled platform or an
  // absent/unknown session has no server consent record to gate on. Note this
  // is NOT gated on isLocalMode — a local-mode client with a platform session
  // still re-reviews stale terms.
  if (
    state.isPlatformDisabled ||
    state.platformSession !== "present" ||
    consentIsCurrent(state)
  ) {
    return null;
  }

  // The flags boot false and hydrate asynchronously — a redirect decided
  // before hydration would bounce a fully consented user to review-terms.
  // Local mode decides immediately: its platform-session paths that enforce
  // consent hydrate synchronously during session init, and the gateway-probe
  // path never hydrates, so waiting there would hang navigation.
  if (!state.consentHydrated && !state.isLocalMode) {
    return { action: "wait" };
  }

  const returnTo = encodeURIComponent(pathnameWithSearch);
  return { action: "redirect", to: `${routes.reviewTerms}?returnTo=${returnTo}` };
}

// ---------------------------------------------------------------------------
// onboarding-intercept
// ---------------------------------------------------------------------------

function resolveOnboardingIntercept(
  state: NavigationState,
  intendedDestination: string,
): NavigationDecision {
  if (state.isLocalMode && state.hasAssistants) return { action: "allow" };
  if (hasCompletedOnboarding(state)) return { action: "allow" };

  const path = extractPathname(intendedDestination);
  if (!path.startsWith(routes.assistant)) return { action: "allow" };
  if (path.startsWith(`${routes.assistant}/onboarding`)) return { action: "allow" };
  if (path === routes.reviewTerms) return { action: "allow" };

  return {
    action: "redirect",
    to: onboardingEntrypoint(state.isLocalMode),
  };
}

// ---------------------------------------------------------------------------
// hatch-gate
// ---------------------------------------------------------------------------

function resolveHatchGate(state: NavigationState): NavigationDecision {
  if (!state.sessionSettled) return { action: "wait" };
  if (!state.isAuthenticated && !state.isLocalMode) {
    return { action: "redirect", to: routes.account.login };
  }
  if (!hasCompletedOnboarding(state)) {
    return { action: "redirect", to: onboardingEntrypoint(state.isLocalMode) };
  }
  // A stale toggle must be re-reviewed before hatching, even via direct navigation.
  if (!state.isLocalMode && !consentIsCurrent(state)) {
    return { action: "redirect", to: routes.reviewTerms };
  }
  return { action: "allow" };
}

// ---------------------------------------------------------------------------
// post-auth
// ---------------------------------------------------------------------------

// The bring-your-agent import funnel (marketing /import page) replaces
// onboarding entirely: the imported agent's data IS the setup. A signup that
// started there must land back on /import; the funnel offers an explicit
// "skip import" path into onboarding instead. Other signup entry points
// (including plugin-attributed signups) keep the onboarding redirect.
const IMPORT_FUNNEL_PATH = "/import";

function isImportFunnelDestination(destination: string): boolean {
  return (
    destination === IMPORT_FUNNEL_PATH ||
    destination.startsWith(`${IMPORT_FUNNEL_PATH}?`) ||
    destination.startsWith(`${IMPORT_FUNNEL_PATH}/`)
  );
}

function resolvePostAuth(
  authIntent: "login" | "signup",
  returnTo: string | null,
  fallback: string,
): NavigationDecision {
  const destination = sanitizeReturnTo(returnTo, fallback);
  // The shared resolver stashes a pricing-CTA checkout package across signup,
  // discards a stale stash for any non-checkout auth, and picks the
  // destination (privacy for signup, the sanitized `returnTo` for login).
  const resolved = resolveSignupCheckoutDestination({
    intent: authIntent,
    returnTo: destination,
  });
  // The import funnel replaces onboarding: a signup that started on /import
  // lands back there instead of the consent screen.
  if (authIntent === "signup" && isImportFunnelDestination(destination)) {
    return { action: "redirect", to: destination };
  }
  return { action: "redirect", to: resolved };
}

// ---------------------------------------------------------------------------
// post-retire
// ---------------------------------------------------------------------------

function resolvePostRetire(state: NavigationState): NavigationDecision {
  if (state.hasAssistants) {
    // select-assistant is local-only; platform users go straight to /assistant
    return {
      action: "redirect",
      to: state.isLocalMode ? routes.selectAssistant : routes.assistant,
    };
  }
  if (!state.isLocalMode) {
    return { action: "redirect", to: routes.onboarding.privacy };
  }
  if (state.platformSession === "present") {
    return { action: "redirect", to: routes.onboarding.hosting };
  }
  return { action: "redirect", to: routes.welcome };
}
