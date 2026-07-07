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
  const isPreview = url.searchParams.get("preview") === "true";
  // Developer "Replay Hatch Failure" tool: the hatching screen short-circuits
  // straight to its error UI when `fail` is present (no real hatch side
  // effects), so it's safe to let preview through for that one case even
  // though hatching is otherwise excluded from the previewable routes above.
  const isHatchFailurePreview =
    isPreview &&
    url.pathname === routes.onboarding.hatching &&
    url.searchParams.get("fail") !== null;
  if (
    (isPreview && previewableRoutes.has(url.pathname)) ||
    isHatchFailurePreview
  ) {
    return next();
  }
  // Auth has already been verified by the parent auth middleware.
  const decision = resolveNavigation(
    buildNavigationState({ sessionSettled: true, isAuthenticated: true }),
    { kind: "route-guard", pathname: url.pathname },
  );
  // A "wait" decision (still-hydrating state) falls through to next(): the
  // parent auth middleware owns hydration waits, so rendering is the safe
  // fallback here.
  if (decision.action === "redirect") throw redirect(decision.to);
  return next();
};
