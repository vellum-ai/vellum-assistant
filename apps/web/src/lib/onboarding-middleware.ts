import { redirect, type MiddlewareFunction } from "react-router";

import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";

export const localModeOnlyMiddleware: MiddlewareFunction = async (
  _args,
  next,
) => {
  const decision = resolveNavigation(
    buildNavigationState(),
    { kind: "route-guard", pathname: "/assistant/onboarding/welcome" },
  );
  if (decision.action === "redirect") throw redirect(decision.to);
  return next();
};

export const onboardingCompletedMiddleware: MiddlewareFunction = async (
  { request },
  next,
) => {
  const url = new URL(request.url);
  const decision = resolveNavigation(
    buildNavigationState({ isReplay: url.searchParams.has("replay") }),
    { kind: "route-guard", pathname: url.pathname },
  );
  if (decision.action === "redirect") throw redirect(decision.to);
  return next();
};
