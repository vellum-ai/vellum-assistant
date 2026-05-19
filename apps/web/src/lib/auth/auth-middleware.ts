/**
 * React Router v7 auth middleware.
 *
 * Runs before any protected route component renders. When auth is
 * required (`VITE_AUTH_REQUIRED="true"`), unauthenticated users are
 * redirected to login. When auth is optional (local dev, self-hosting),
 * the middleware passes through with an anonymous user context.
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

import { useAuthStore, type AuthUser } from "@/stores/auth-store.js";
import { requiresAuth } from "@/lib/auth/require-auth.js";

const ANONYMOUS_USER: AuthUser = {
  id: null,
  username: null,
  email: null,
  isStaff: false,
  firstName: "",
  lastName: "",
};

export const authUserContext = createRouterContext<AuthUser>(ANONYMOUS_USER);

export const authMiddleware: MiddlewareFunction = async ({ context }, next) => {
  const { isLoggedIn, isLoading, user } = useAuthStore.getState();

  if (isLoading) {
    // Session probe still in flight — wait for it.
    await waitForAuthReady();
    return authMiddleware({ context } as Parameters<MiddlewareFunction>[0], next);
  }

  if (!requiresAuth()) {
    context.set(authUserContext, user ?? ANONYMOUS_USER);
    return next();
  }

  if (!isLoggedIn || !user) {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
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
    // Resolve immediately if loading already finished between the
    // getState() call and this subscription.
    if (!useAuthStore.getState().isLoading) {
      unsubscribe();
      resolve();
    }
  });
}
