import type { PlatformSessionStatus } from "@/stores/session-status";
import { sanitizeReturnTo } from "@/domains/account/return-to";
import { routes } from "@/utils/routes";

// ---------------------------------------------------------------------------
// State — every variable that can influence a routing decision
// ---------------------------------------------------------------------------

export interface NavigationState {
  isLocalMode: boolean;
  isGatewayAuth: boolean;
  hasAssistants: boolean;
  sessionSettled: boolean;
  isAuthenticated: boolean;
  platformSession: PlatformSessionStatus;
  tosAccepted: boolean;
  aiDataConsent: boolean;
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
    };

// ---------------------------------------------------------------------------
// Decision — what the caller should do
// ---------------------------------------------------------------------------

export type NavigationDecision =
  | { action: "allow" }
  | { action: "redirect"; to: string }
  | { action: "wait" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ONBOARDING_PREFIX = `${routes.assistant}/onboarding`;

const LOCAL_ONLY_ONBOARDING_PATHS: Set<string> = new Set([
  routes.onboarding.welcome,
  routes.onboarding.selectAssistant,
  routes.onboarding.hosting,
  routes.onboarding.apiKey,
]);

function isOnboardingPath(pathname: string): boolean {
  return pathname.startsWith(`${ONBOARDING_PREFIX}/`) || pathname === ONBOARDING_PREFIX;
}

function onboardingEntrypoint(isLocalMode: boolean): string {
  return isLocalMode ? routes.onboarding.welcome : routes.onboarding.privacy;
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
  }
}

// ---------------------------------------------------------------------------
// route-guard
// ---------------------------------------------------------------------------

function resolveRouteGuard(
  state: NavigationState,
  pathnameWithSearch: string,
): NavigationDecision {
  // Split off the query string so path-matching uses the bare path,
  // but returnTo encoding preserves the full URL for post-login return.
  const qIdx = pathnameWithSearch.indexOf("?");
  const path = qIdx >= 0 ? pathnameWithSearch.slice(0, qIdx) : pathnameWithSearch;

  // 1. Wait for session to settle
  if (!state.sessionSettled) return { action: "wait" };

  // 2. Gateway auth bypasses all guards
  if (state.isGatewayAuth) return { action: "allow" };

  // 3. Unauthenticated
  if (!state.isAuthenticated) {
    if (state.isLocalMode && isOnboardingPath(path)) {
      if (path === routes.onboarding.selectAssistant && !state.hasAssistants) {
        return { action: "redirect", to: routes.onboarding.hosting };
      }
      return { action: "allow" };
    }
    if (state.isLocalMode && !state.hasAssistants) {
      return { action: "redirect", to: routes.onboarding.welcome };
    }
    if (state.isLocalMode) {
      return { action: "redirect", to: routes.onboarding.selectAssistant };
    }
    return {
      action: "redirect",
      to: `${routes.account.login}?returnTo=${encodeURIComponent(pathnameWithSearch)}`,
    };
  }

  // 4. Authenticated, on an onboarding route
  if (isOnboardingPath(path)) {
    if (LOCAL_ONLY_ONBOARDING_PATHS.has(path) && !state.isLocalMode) {
      return { action: "redirect", to: routes.assistant };
    }
    if (path === routes.onboarding.selectAssistant && !state.hasAssistants) {
      return { action: "redirect", to: routes.onboarding.hosting };
    }
    if (path === routes.onboarding.hatching && !(state.tosAccepted && state.aiDataConsent)) {
      return { action: "redirect", to: onboardingEntrypoint(state.isLocalMode) };
    }
    return { action: "allow" };
  }

  // 5. Authenticated, local mode, no assistants — needs onboarding
  if (state.isLocalMode && !state.hasAssistants) {
    if (state.platformSession === "unknown") return { action: "wait" };
    if (state.platformSession === "present") {
      return { action: "redirect", to: routes.onboarding.hosting };
    }
    return { action: "redirect", to: routes.onboarding.welcome };
  }

  // 6. Authenticated, platform mode, onboarding not completed
  if (!state.isLocalMode && !(state.tosAccepted && state.aiDataConsent)) {
    return { action: "redirect", to: routes.onboarding.privacy };
  }

  // 7. All clear
  return { action: "allow" };
}

// ---------------------------------------------------------------------------
// onboarding-intercept
// ---------------------------------------------------------------------------

function resolveOnboardingIntercept(
  state: NavigationState,
  intendedDestination: string,
): NavigationDecision {
  if (state.isLocalMode && state.hasAssistants) return { action: "allow" };
  if (state.tosAccepted && state.aiDataConsent) return { action: "allow" };

  const path = extractPathname(intendedDestination);
  if (!path.startsWith(routes.assistant)) return { action: "allow" };
  if (path.startsWith(`${routes.assistant}/onboarding`)) return { action: "allow" };

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
  if (!(state.tosAccepted && state.aiDataConsent)) {
    return { action: "redirect", to: onboardingEntrypoint(state.isLocalMode) };
  }
  return { action: "allow" };
}

// ---------------------------------------------------------------------------
// post-auth
// ---------------------------------------------------------------------------

function resolvePostAuth(
  authIntent: "login" | "signup",
  returnTo: string | null,
  fallback: string,
): NavigationDecision {
  if (authIntent === "signup") {
    return { action: "redirect", to: routes.onboarding.privacy };
  }
  return { action: "redirect", to: sanitizeReturnTo(returnTo, fallback) };
}

