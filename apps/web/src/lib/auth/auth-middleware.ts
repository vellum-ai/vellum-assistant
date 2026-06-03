/**
 * React Router v7 auth middleware.
 *
 * Runs before any protected route component renders. Unauthenticated
 * users are redirected to `/account/login` with a `returnTo` parameter.
 *
 * References:
 * - https://reactrouter.com/how-to/middleware
 * - https://reactrouter.com/upgrading/future#futurev8_middleware
 */
import {
  redirect,
  createContext as createRouterContext,
  type MiddlewareFunction,
} from "react-router";

import { useAuthStore, type AuthUser } from "@/stores/auth-store";
import { isAuthenticated, isSessionSettled } from "@/stores/session-status";
import { isGatewayAuthMode } from "@/lib/auth/gateway-session";
import { isLocalMode, hasAssistants } from "@/lib/local-mode";
import { resolveLocalOnboardingRoute } from "@/utils/local-onboarding-route";
import { whenStoreState } from "@/utils/when-store-state";

export const authUserContext = createRouterContext<AuthUser | null>(null);

export const authMiddleware: MiddlewareFunction = async ({ request, context }, next) => {
  const { sessionStatus, user } = useAuthStore.getState();

  if (!isSessionSettled(sessionStatus)) {
    await whenStoreState(useAuthStore, (state) => isSessionSettled(state.sessionStatus));
    return authMiddleware({ request, context } as Parameters<MiddlewareFunction>[0], next);
  }

  if (!isAuthenticated(sessionStatus) || !user) {
    if (isGatewayAuthMode()) {
      return next();
    }
    const url = new URL(request.url);
    const returnTo = encodeURIComponent(url.pathname + url.search);
    throw redirect(`/account/login?returnTo=${returnTo}`);
  }

  if (isLocalMode() && !hasAssistants()) {
    const url = new URL(request.url);
    if (!url.pathname.includes("/onboarding/") && !url.pathname.includes("/account")) {
      throw redirect(await resolveLocalOnboardingRoute());
    }
  }

  context.set(authUserContext, user);
  return next();
};
