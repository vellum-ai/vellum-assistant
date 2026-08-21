import type { PlatformSessionStatus } from "@/stores/session-status";
import { sanitizeReturnTo } from "@/domains/account/return-to";
import { onboardingDestinationAfterConsent } from "@/domains/onboarding/onboarding-destination";
import { resolveSignupCheckoutDestination } from "@/lib/billing/post-auth-checkout";
import { routes } from "@/utils/routes";

// ---------------------------------------------------------------------------
// State — every variable that can influence a routing decision
// ---------------------------------------------------------------------------

export interface NavigationState {
  isLocalClient: boolean;
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
  /**
   * Whether `consentHydrated` above was forced by the auth middleware after its
   * hydration wait timed out. The consent flags then still read their boot
   * `false`, so a gate that treats them as a settled "not consented" would
   * evict a consented user. Absent on every other caller — only the middleware
   * can know its own wait ran out.
   */
  consentHydrationTimedOut?: boolean;
  /** Whether the resolved assistants list reflects at least one authoritative load. */
  assistantsHydrated: boolean;
  /**
   * Whether any resolved assistant is already past first-run onboarding.
   * Hatch age is the stored proxy (see `hasOnboardedAssistant`).
   */
  alreadyOnboarded: boolean;
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

const LOCAL_ONLY_STANDALONE_PATHS: Set<string> = new Set([routes.welcome]);

function isOnboardingPath(pathname: string): boolean {
  return (
    pathname.startsWith(`${ONBOARDING_PREFIX}/`) ||
    pathname === ONBOARDING_PREFIX
  );
}

function onboardingEntrypoint(isLocalClient: boolean): string {
  return isLocalClient ? routes.welcome : routes.onboarding.privacy;
}

/**
 * The two paths a finished Stripe Checkout can land on: the platform's
 * hardcoded non-native `success_url` (`/assistant/settings/billing`, which
 * `BillingRedirectPage` forwards) and the Billing tab's own path, which the
 * native deep-link return and `usageBillingCheckout()` build directly.
 */
const POST_CHECKOUT_LANDING_PATHS: ReadonlySet<string> = new Set([
  `${routes.settings.root}/billing`,
  routes.settings.usage,
]);

/**
 * Whether `destination` is a billing landing carrying Stripe's `session_id` —
 * the return leg of a finished purchase rather than a plain visit to the same
 * page.
 *
 * `destination` is a path with its query: the route guard asks about the
 * location it is deciding on, and `requiresPlatformSession` asks about a
 * `returnTo`. Both put the same question to the same URL shape, so they share
 * this answer.
 */
export function isPostCheckoutReturn(destination: string): boolean {
  const qIdx = destination.indexOf("?");
  if (qIdx < 0) {
    return false;
  }
  const path = destination.slice(0, qIdx).split("#")[0] ?? "";
  if (!POST_CHECKOUT_LANDING_PATHS.has(path)) {
    return false;
  }
  return new URLSearchParams(destination.slice(qIdx + 1)).has("session_id");
}

/**
 * The onboarding query param naming a hatch that is the return leg of a
 * completed Stripe Checkout. Only {@link managedProvisioningDestination} sets
 * it, and only for a billing landing carrying Stripe's `session_id`.
 *
 * Deliberately separate from `hosting=vellum-cloud`, which says only that the
 * hatch is managed — a hosting choice a free user can make too. The purchased-
 * provisioning wait holds for a lagging subscription webhook on this param
 * alone, so conflating the two would park every free managed hatch on a
 * spinner.
 */
export const POST_CHECKOUT_HATCH_PARAM = "post_checkout";

/**
 * The provisioning funnel entry for a purchase with no managed assistant to
 * apply to.
 *
 * `hosting=vellum-cloud` is the onboarding flow's managed-hatch marker (see
 * `adopt-existing-assistant`): it names a managed hatch even in a local-mode
 * build, where the client would otherwise let the local gateway answer for the
 * assistant and skip the purchased-provisioning wait. Carrying it onto the
 * research entry is load-bearing on Electron for exactly that reason —
 * `shouldAdoptExistingAssistant` reads it to force the managed hatch instead of
 * adopting a local gateway assistant.
 *
 * {@link POST_CHECKOUT_HATCH_PARAM} adds the narrower fact that money has
 * already changed hands, which is what lets the hatch treat a still-base
 * subscription read as a pending webhook rather than a free org.
 */
function managedProvisioningDestination(): string {
  // The headless research entry runs the purchased-provisioning wait behind
  // the onboarding form. `isLocalHatch` is false by construction —
  // `hosting=vellum-cloud` forces the managed hatch on every client.
  const route = onboardingDestinationAfterConsent({
    isLocalHatch: false,
  });
  return `${route}?hosting=vellum-cloud&${POST_CHECKOUT_HATCH_PARAM}=1`;
}

/**
 * The provisioning funnel entries a paid return can name: the headless research
 * onboarding and the foreground hatching screen retained for return URLs
 * stashed by older clients. Both provision the purchased assistant, so both are
 * consent-gated and resumable from the privacy screen.
 */
const PROVISIONING_FUNNEL_PATHS: Set<string> = new Set([
  routes.onboarding.hatching,
  routes.onboarding.research,
]);

/**
 * `value` when it names a paid managed hatch, else `null`.
 *
 * Narrower than {@link sanitizeReturnTo}'s open-redirect check: the onboarding
 * privacy screen navigates here in place of the standard onboarding step once
 * consent is recorded, so admitting any same-origin path would let a crafted
 * link skip the rest of the funnel. Only a {@link PROVISIONING_FUNNEL_PATHS}
 * entry carrying {@link POST_CHECKOUT_HATCH_PARAM} qualifies — the screen
 * resumes either the foreground or the headless paid provisioning entry, and
 * that closed set of two keeps the anti-open-redirect property.
 */
export function postCheckoutHatchReturnTo(
  value: string | null | undefined,
): string | null {
  const destination = sanitizeReturnTo(value, "");
  if (!destination.startsWith("/")) {
    return null;
  }
  const qIdx = destination.indexOf("?");
  if (qIdx < 0 || !PROVISIONING_FUNNEL_PATHS.has(destination.slice(0, qIdx))) {
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
      return resolvePostAuth(
        state,
        query.authIntent,
        query.returnTo,
        query.fallback,
      );
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
//   3. Bypass             — gateway auth skips everything but a paid return
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
  const path =
    qIdx >= 0 ? pathnameWithSearch.slice(0, qIdx) : pathnameWithSearch;

  for (const step of ROUTE_GUARD_PIPELINE) {
    const decision = step(state, path, pathnameWithSearch);
    if (decision) {
      return decision;
    }
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
 * into the provisioning funnel instead, which provisions the assistant and
 * applies the purchased specs.
 *
 * The destination is {@link managedProvisioningDestination}: its marker is what
 * makes a local-mode client provision on the platform and hold for the
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
 * Consent is still enforced: re-resolving the destination runs
 * `allowSetupRoutes`, which bounces an unconsented user to the consent
 * entrypoint. `allowGatewayAuth` suspends its bypass for exactly these URLs so
 * a gateway session reaches that step.
 */
function requirePostCheckoutProvisioning(
  state: NavigationState,
  _path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  // An org with a platform-hosted assistant has a target for the purchase, so
  // the return stays on billing and the pro onboarding wizard consumes
  // `session_id` there.
  if (state.hasPlatformHostedAssistant) {
    return null;
  }
  if (!isPostCheckoutReturn(pathnameWithSearch)) {
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
  if (!state.isLocalClient && !state.assistantsHydrated) {
    return { action: "wait" };
  }
  // A local-mode client reaches "authenticated" on its gateway session alone,
  // so the platform session is a separate question — and the managed hatch this
  // redirect starts needs one for the org header and the purchased ceiling. The
  // probe boots `"unknown"`, so hold until it settles. When it settles absent
  // there is no account to provision into: fall through to billing, whose login
  // notice carries `session_id` through sign-in and lands back here.
  if (state.isLocalClient) {
    if (state.platformSession === "unknown") {
      return { action: "wait", waitFor: "platform-session" };
    }
    if (state.platformSession !== "present") {
      return null;
    }
  }
  return { action: "redirect", to: managedProvisioningDestination() };
}

/**
 * A gateway session answers for itself, so it skips the rest of the pipeline —
 * except on a paid return to a provisioning funnel entry.
 *
 * The bypass runs before `allowSetupRoutes`, so leaving it unconditional would
 * let an Electron paid return reach the headless research entry and start the
 * purchased hatch with no consent recorded. Suspending it only for a
 * {@link postCheckoutHatchReturnTo} URL keeps every other gateway-auth surface
 * — including the local adopt flow's unmarked research entry — on today's
 * bypass, and hands exactly the paid case to the consent steps below.
 */
function allowGatewayAuth(
  state: NavigationState,
  _path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  if (!state.isGatewayAuth) {
    return null;
  }
  if (postCheckoutHatchReturnTo(pathnameWithSearch)) {
    return null;
  }
  return { action: "allow" };
}

function stripRemoteGatewayPublicPathPrefix(
  state: NavigationState,
  pathnameWithSearch: string,
): string {
  const prefix = state.remoteGatewayPublicPathPrefix;
  if (!state.isRemoteGateway || !prefix) {
    return pathnameWithSearch;
  }
  if (pathnameWithSearch === prefix) {
    return routes.assistant;
  }
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
  if (!state.isRemoteGateway || state.isAuthenticated) {
    return null;
  }

  const returnTo = stripRemoteGatewayPublicPathPrefix(
    state,
    pathnameWithSearch,
  );
  return {
    action: "redirect",
    to: `${routes.remotePair}?returnTo=${encodeURIComponent(returnTo)}`,
  };
}

/**
 * The local-mode chooser, decided the same way for an unauthenticated visit
 * (`requireAuth`) and an authenticated one (`enforceModeBoundary`): an empty
 * lockfile has nothing to choose from, so the visit funnels to hosting.
 *
 * Deciding either way is what keeps the local chooser short-circuiting ahead of
 * the assistant and consent gates: it is itself an onboarding surface,
 * reachable before there is a platform session to gate on.
 */
function localChooserDecision(state: NavigationState): NavigationDecision {
  if (!state.hasAssistants) {
    return { action: "redirect", to: routes.onboarding.hosting };
  }
  return { action: "allow" };
}

function requireAuth(
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  if (state.isAuthenticated) {
    return null;
  }

  if (
    state.isLocalClient &&
    (isOnboardingPath(path) ||
      LOCAL_ONLY_STANDALONE_PATHS.has(path) ||
      path === routes.selectAssistant)
  ) {
    if (path === routes.selectAssistant) {
      return localChooserDecision(state);
    }
    return { action: "allow" };
  }
  if (state.isLocalClient && !state.hasAssistants) {
    return { action: "redirect", to: routes.welcome };
  }
  if (state.isLocalClient) {
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
  // The chooser is reachable in every mode: local clients keep their
  // lockfile-driven picker, and the platform build hosts the hub chooser. The
  // non-local case falls through rather than allowing, so `requireConsent`
  // below still binds on this route; `requireAssistant` exempts it on purpose
  // (see NO_ASSISTANT_EXEMPT_PATHS).
  if (path === routes.selectAssistant) {
    return state.isLocalClient ? localChooserDecision(state) : null;
  }

  if (LOCAL_ONLY_STANDALONE_PATHS.has(path)) {
    if (!state.isLocalClient) {
      return { action: "redirect", to: routes.assistant };
    }
    return { action: "allow" };
  }

  if (LOCAL_ONLY_ONBOARDING_PATHS.has(path) && !state.isLocalClient) {
    return { action: "redirect", to: routes.assistant };
  }

  return null;
}

/**
 * Where an unconsented user who reached a provisioning funnel entry is sent.
 *
 * A paid return carries its funnel URL as `returnTo`, the same contract
 * `review-terms` uses, and the privacy screen resumes it on Start. Without the
 * carry the funnel's markers are lost on the bounce and the paying user
 * finishes the hatch at the baseline plan. Every other funnel bounce gets the
 * bare entrypoint.
 *
 * Local mode is a deliberate exception to that carry: its `welcome` entrypoint
 * reads no `returnTo`, so the hatch finishes at baseline and the server-side
 * post-hatch reconcile applies the purchased specs.
 */
function consentBounceDestination(
  state: NavigationState,
  pathnameWithSearch: string,
): string {
  const entrypoint = onboardingEntrypoint(state.isLocalClient);
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

  if (!isOnboardingPath(path)) {
    return null;
  }

  // An already-onboarded assistant should not re-enter first-run privacy.
  // Research stays reachable on demand (replay); only the automatic privacy
  // entry is bounced. A paid hatch riding on `returnTo` is resumed so a
  // purchased resize is not dropped.
  if (path === routes.onboarding.privacy && state.alreadyOnboarded) {
    const qIdx = pathnameWithSearch.indexOf("?");
    const returnTo =
      qIdx >= 0
        ? new URLSearchParams(pathnameWithSearch.slice(qIdx + 1)).get(
            "returnTo",
          )
        : null;
    const paidReturn = postCheckoutHatchReturnTo(returnTo);
    if (paidReturn) {
      return { action: "redirect", to: paidReturn };
    }
    return { action: "redirect", to: routes.assistant };
  }

  return enforceFunnelConsent(state, path, pathnameWithSearch);
}

/**
 * Consent for the two provisioning funnel entries, which `requireConsent` never
 * reaches — every onboarding path is allowed before it runs. It decides every
 * onboarding path outright: anything that is not a funnel entry is plainly
 * allowed.
 *
 * The hatching entry keeps exactly the gate it has always had — reached from
 * in-app navigation and from the native paid return, it decides on the flags in
 * hand and leaves stale-toggle review to the screen's own `hatch-gate`. The
 * research entry is the one a cold paid deep link lands on, so it also waits
 * for the flags to hydrate and re-reviews a stale toggle before starting a
 * hatch the user paid for.
 */
function enforceFunnelConsent(
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
): NavigationDecision {
  if (!PROVISIONING_FUNNEL_PATHS.has(path)) {
    return { action: "allow" };
  }

  if (path === routes.onboarding.research) {
    // The consent flags are still at their boot defaults on a cold deep link,
    // and bouncing on them would send an already-consented user to privacy.
    // Local mode is excluded for the same reason as in `requireConsent`: its
    // consent either hydrates synchronously during session init or never does,
    // so waiting would hang navigation.
    if (!state.isLocalClient && !state.consentHydrated) {
      return { action: "wait" };
    }
    // A hydration that never landed leaves those boot defaults behind a forced
    // `consentHydrated`, so the gates below would read a consented user as
    // un-onboarded and restart their funnel. Fail open to the entry's
    // unconditional contract instead; a hydrated read still gates.
    if (state.consentHydrationTimedOut) {
      return { action: "allow" };
    }
  }

  if (!hasCompletedOnboarding(state)) {
    return {
      action: "redirect",
      to: consentBounceDestination(state, pathnameWithSearch),
    };
  }

  // A stale toggle must be re-reviewed before a hatch the user paid for.
  // Research-only: the hatching entry — where a `returnTo` stashed by an older
  // client may still point — reaches a screen whose own `hatch-gate` already
  // re-reviews stale terms, so gating it twice would only change where it
  // lands. Gated on the paid marker so the ordinary funnel keeps its exemption,
  // and on a live platform session for the same reason as `requireConsent`:
  // there is nothing to re-review against without one.
  if (
    path === routes.onboarding.research &&
    postCheckoutHatchReturnTo(pathnameWithSearch) &&
    !state.isPlatformDisabled &&
    state.platformSession === "present" &&
    !consentIsCurrent(state)
  ) {
    const returnTo = encodeURIComponent(pathnameWithSearch);
    return {
      action: "redirect",
      to: `${routes.reviewTerms}?returnTo=${returnTo}`,
    };
  }

  return { action: "allow" };
}

/**
 * The routes a no-assistant user reaches without being funneled into
 * provisioning first.
 *
 * `checkout` is where the marketing pricing CTAs deep-link a brand-new user to
 * start Stripe checkout for a chosen package; every other billing surface still
 * provisions first. `selectAssistant` is the hub chooser, the one screen that
 * answers the empty state for an account whose assistants are all self-hosted:
 * remembered origins are client-local, so they never reach `hasAssistants`, and
 * a `?register=` handoff arriving from a self-hosted origin would be lost on the
 * funnel bounce before the chooser could record it.
 *
 * Only the funnel is lifted. `requireConsent` runs after this step, so neither
 * route can be reached on unaccepted or stale terms.
 */
const NO_ASSISTANT_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  routes.checkout,
  routes.selectAssistant,
]);

function requireAssistant(
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  if (state.hasAssistants) {
    return null;
  }

  if (NO_ASSISTANT_EXEMPT_PATHS.has(path)) {
    return null;
  }

  if (state.isLocalClient) {
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
    return {
      action: "redirect",
      to: `${routes.reviewTerms}?returnTo=${returnTo}`,
    };
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
  // is NOT gated on isLocalClient — a local-mode client with a platform session
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
  if (!state.consentHydrated && !state.isLocalClient) {
    return { action: "wait" };
  }

  const returnTo = encodeURIComponent(pathnameWithSearch);
  return {
    action: "redirect",
    to: `${routes.reviewTerms}?returnTo=${returnTo}`,
  };
}

// ---------------------------------------------------------------------------
// onboarding-intercept
// ---------------------------------------------------------------------------

function resolveOnboardingIntercept(
  state: NavigationState,
  intendedDestination: string,
): NavigationDecision {
  if (state.isLocalClient && state.hasAssistants) {
    return { action: "allow" };
  }
  if (hasCompletedOnboarding(state) || state.alreadyOnboarded) {
    return { action: "allow" };
  }

  const path = extractPathname(intendedDestination);
  if (!path.startsWith(routes.assistant)) {
    return { action: "allow" };
  }
  if (path.startsWith(`${routes.assistant}/onboarding`)) {
    return { action: "allow" };
  }
  if (path === routes.reviewTerms) {
    return { action: "allow" };
  }

  return {
    action: "redirect",
    to: onboardingEntrypoint(state.isLocalClient),
  };
}

// ---------------------------------------------------------------------------
// hatch-gate
// ---------------------------------------------------------------------------

function resolveHatchGate(state: NavigationState): NavigationDecision {
  if (!state.sessionSettled) {
    return { action: "wait" };
  }
  if (!state.isAuthenticated && !state.isLocalClient) {
    return { action: "redirect", to: routes.account.login };
  }
  if (!hasCompletedOnboarding(state)) {
    return { action: "redirect", to: onboardingEntrypoint(state.isLocalClient) };
  }
  // A stale toggle must be re-reviewed before hatching, even via direct navigation.
  if (!state.isLocalClient && !consentIsCurrent(state)) {
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

function isOnboardingResearchPath(destination: string): boolean {
  const path = extractPathname(destination);
  const qIdx = path.indexOf("?");
  const pathname = qIdx < 0 ? path : path.slice(0, qIdx);
  return (
    pathname === routes.onboarding.privacy ||
    pathname === routes.onboarding.research
  );
}

function resolvePostAuth(
  state: NavigationState,
  authIntent: "login" | "signup",
  returnTo: string | null,
  fallback: string,
): NavigationDecision {
  const destination = sanitizeReturnTo(returnTo, fallback);
  // The import funnel replaces onboarding: a signup that started on /import
  // lands back there instead of the consent screen.
  if (authIntent === "signup" && isImportFunnelDestination(destination)) {
    return { action: "redirect", to: destination };
  }

  // An already-onboarded assistant skips first-run privacy and research.
  // Treat the auth as a login so a pricing-CTA checkout stash is not marked
  // for the privacy screen to consume. A paid hatch return keeps its
  // destination so a purchased resize is not dropped.
  if (state.alreadyOnboarded) {
    const skipTarget = postCheckoutHatchReturnTo(destination)
      ? destination
      : isOnboardingResearchPath(destination)
        ? fallback
        : destination;
    resolveSignupCheckoutDestination({
      intent: "login",
      returnTo: skipTarget,
    });
    return { action: "redirect", to: skipTarget };
  }

  // The shared resolver stashes a pricing-CTA checkout package across signup,
  // discards a stale stash for any non-checkout auth, and picks the
  // destination (privacy for signup, the sanitized `returnTo` for login).
  const resolved = resolveSignupCheckoutDestination({
    intent: authIntent,
    returnTo: destination,
  });
  return { action: "redirect", to: resolved };
}

// ---------------------------------------------------------------------------
// post-retire
// ---------------------------------------------------------------------------

function resolvePostRetire(state: NavigationState): NavigationDecision {
  if (state.hasAssistants) {
    // Platform users land on /assistant post-retire; the chooser is an
    // explicit destination there, not the retire landing.
    return {
      action: "redirect",
      to: state.isLocalClient ? routes.selectAssistant : routes.assistant,
    };
  }
  if (!state.isLocalClient) {
    return { action: "redirect", to: routes.onboarding.privacy };
  }
  if (state.platformSession === "present") {
    return { action: "redirect", to: routes.onboarding.hosting };
  }
  return { action: "redirect", to: routes.welcome };
}
