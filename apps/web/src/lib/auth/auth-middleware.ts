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
import { isGatewayAuthMode } from "@/lib/auth/gateway-session";
import { isLocalMode, hasAssistants } from "@/lib/local-mode";
import { routes } from "@/utils/routes";

export const authUserContext = createRouterContext<AuthUser | null>(null);

export const authMiddleware: MiddlewareFunction = async ({ request, context }, next) => {
  const { isLoggedIn, isLoading, user } = useAuthStore.getState();

  if (isLoading) {
    await waitForAuthReady();
    return authMiddleware({ request, context } as Parameters<MiddlewareFunction>[0], next);
  }

  if (!isLoggedIn || !user) {
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
      // The hosting-vs-welcome fork keys off `hasPlatformSession`, which is set
      // by a fire-and-forget probe that may still be in flight here (the local
      // gateway auth paths return before the platform session is known). Reading
      // it early reports an ambiguous `false` and sends a returning platform
      // user to the new-user welcome flow. Wait for the probe to settle first.
      await waitForPlatformSessionResolved();
      const { hasPlatformSession } = useAuthStore.getState();
      throw redirect(hasPlatformSession ? routes.onboarding.hosting : routes.onboarding.welcome);
    }
  }

  context.set(authUserContext, user);
  return next();
};

function waitForAuthReady(): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = useAuthStore.subscribe((state) => {
      if (!state.isLoading) {
        unsubscribe();
        resolve();
      }
    });
    if (!useAuthStore.getState().isLoading) {
      unsubscribe();
      resolve();
    }
  });
}

function waitForPlatformSessionResolved(): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = useAuthStore.subscribe((state) => {
      if (state.platformSessionResolved) {
        unsubscribe();
        resolve();
      }
    });
    if (useAuthStore.getState().platformSessionResolved) {
      unsubscribe();
      resolve();
    }
  });
}
