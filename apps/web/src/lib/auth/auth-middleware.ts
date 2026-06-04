import {
  redirect,
  createContext as createRouterContext,
  type MiddlewareFunction,
} from "react-router";

import { useAuthStore, type AuthUser } from "@/stores/auth-store";
import { isSessionSettled } from "@/stores/session-status";
import { isLocalMode, hasAssistants } from "@/lib/local-mode";
import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import {
  clearOnboardingCompleted,
  readOnboardingCompleted,
} from "@/domains/onboarding/prefs";
import { whenStoreState } from "@/utils/when-store-state";

export const authUserContext = createRouterContext<AuthUser | null>(null);

const PLATFORM_SESSION_PROBE_TIMEOUT_MS = 5_000;

export const authMiddleware: MiddlewareFunction = async ({ request, context }, next) => {
  const url = new URL(request.url);

  const state = buildNavigationState({
    isReplay: url.searchParams.has("replay"),
  });

  const decision = resolveNavigation(state, {
    kind: "route-guard",
    pathname: url.pathname,
  });

  if (decision.action === "wait") {
    await whenStoreState(useAuthStore, (s) => isSessionSettled(s.sessionStatus));
    if (isLocalMode() && !hasAssistants()) {
      await whenStoreState(
        useAuthStore,
        (s) => s.platformSession !== "unknown",
        { timeoutMs: PLATFORM_SESSION_PROBE_TIMEOUT_MS },
      );
    }
    return authMiddleware({ request, context } as Parameters<MiddlewareFunction>[0], next);
  }

  if (decision.action === "redirect") {
    // Best-effort cleanup: clear stale onboarding flag when the lockfile
    // has no assistants but localStorage still remembers a prior completion.
    if (isLocalMode() && !hasAssistants() && readOnboardingCompleted()) {
      clearOnboardingCompleted();
    }
    throw redirect(decision.to);
  }

  context.set(authUserContext, useAuthStore.getState().user);
  return next();
};
