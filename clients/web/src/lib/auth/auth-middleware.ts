import {
  redirect,
  createContext as createRouterContext,
  type MiddlewareFunction,
} from "react-router";

import { useAuthStore, type AuthUser } from "@/stores/auth-store";
import { isAuthenticated, isSessionSettled } from "@/stores/session-status";
import { isLocalMode, hasAssistants } from "@/lib/local-mode";
import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { whenStoreState } from "@/utils/when-store-state";

export const authUserContext = createRouterContext<AuthUser | null>(null);

const PLATFORM_SESSION_PROBE_TIMEOUT_MS = 5_000;
const STATE_HYDRATION_TIMEOUT_MS = 5_000;

export const authMiddleware: MiddlewareFunction = (args, next) =>
  resolveWithGuard(args, next, false);

const resolveWithGuard = async (
  { request, context }: Parameters<MiddlewareFunction>[0],
  next: Parameters<MiddlewareFunction>[1],
  hydrationTimedOut: boolean,
): Promise<Awaited<ReturnType<MiddlewareFunction>>> => {
  const url = new URL(request.url);

  // After a timed-out hydration wait, force the hydration flags so the
  // resolver decides on whatever state exists instead of returning another
  // "wait" — a fetch that hangs (never reaching any settle path) must degrade
  // to a decision, not loop navigation in timeout-sized chunks.
  const state = buildNavigationState(
    hydrationTimedOut
      ? { consentHydrated: true, assistantsHydrated: true }
      : undefined,
  );

  const decision = resolveNavigation(state, {
    kind: "route-guard",
    pathname: url.pathname + url.search,
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
    // Platform mode also waits for consent and the assistants list to hydrate
    // — the resolver defers to them, and deciding on their boot defaults would
    // misroute an established user into onboarding. Both resolve immediately
    // when already hydrated. Scoped to sessions that can actually hydrate:
    // local mode's resolver steps never wait on hydration (lockfile-driven),
    // and an unauthenticated session never populates either store, so waiting
    // in those cases would only stall boot.
    let hydrationStillPending = false;
    if (
      !hydrationTimedOut &&
      !isLocalMode() &&
      isAuthenticated(useAuthStore.getState().sessionStatus)
    ) {
      await whenStoreState(useOnboardingStore, (s) => s.consentHydrated, {
        timeoutMs: STATE_HYDRATION_TIMEOUT_MS,
      });
      await whenStoreState(
        useResolvedAssistantsStore,
        (s) => s.assistantsHydrated,
        { timeoutMs: STATE_HYDRATION_TIMEOUT_MS },
      );
      hydrationStillPending =
        !useOnboardingStore.getState().consentHydrated ||
        !useResolvedAssistantsStore.getState().assistantsHydrated;
    }
    return resolveWithGuard(
      { request, context } as Parameters<MiddlewareFunction>[0],
      next,
      hydrationTimedOut || hydrationStillPending,
    );
  }

  if (decision.action === "redirect") {
    throw redirect(decision.to);
  }

  context.set(authUserContext, useAuthStore.getState().user);
  return next();
};
