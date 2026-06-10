import { redirect, type MiddlewareFunction } from "react-router";

import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { routes } from "@/utils/routes";

export const localModeOnlyMiddleware: MiddlewareFunction = async (
  _args,
  next,
) => {
  // Auth has already been verified by the parent auth middleware.
  const decision = resolveNavigation(
    buildNavigationState({ sessionSettled: true, isAuthenticated: true }),
    { kind: "route-guard", pathname: "/assistant/onboarding/hosting" },
  );
  if (decision.action === "redirect") throw redirect(decision.to);
  return next();
};

export const onboardingCompletedMiddleware: MiddlewareFunction = async (
  { request },
  next,
) => {
  const url = new URL(request.url);
  // Developer preview mode bypasses the onboarding guard so completed users
  // can re-walk the privacy/prechat screens without being redirected away.
  // Restricted to only these two routes to prevent preview from bypassing the
  // guard on routes with real side effects (e.g. hatching).
  const previewableRoutes: Set<string> = new Set([
    routes.onboarding.privacy,
    routes.onboarding.prechat,
  ]);
  if (
    url.searchParams.get("preview") === "true" &&
    previewableRoutes.has(url.pathname)
  ) {
    return next();
  }
  // Auth has already been verified by the parent auth middleware.
  const decision = resolveNavigation(
    buildNavigationState({ sessionSettled: true, isAuthenticated: true }),
    { kind: "route-guard", pathname: url.pathname },
  );
  if (decision.action === "redirect") throw redirect(decision.to);
  return next();
};
