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
