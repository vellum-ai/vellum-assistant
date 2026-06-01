import { redirect, type MiddlewareFunction } from "react-router";

import { isLocalMode } from "@/lib/local-mode";
import { readOnboardingCompleted } from "@/domains/onboarding/prefs";
import { routes } from "@/utils/routes";

export const localModeOnlyMiddleware: MiddlewareFunction = async (
  _args,
  next,
) => {
  if (!isLocalMode()) {
    throw redirect(routes.assistant);
  }
  return next();
};

export const onboardingCompletedMiddleware: MiddlewareFunction = async (
  { request },
  next,
) => {
  const url = new URL(request.url);
  if (url.searchParams.has("replay")) {
    return next();
  }

  if (readOnboardingCompleted()) {
    throw redirect(routes.assistant);
  }

  return next();
};
