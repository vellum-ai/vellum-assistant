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
import { captureError } from "@/lib/sentry/capture-error";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { whenStoreState } from "@/utils/when-store-state";

export const authUserContext = createRouterContext<AuthUser | null>(null);

const PLATFORM_SESSION_PROBE_TIMEOUT_MS = 5_000;
const STATE_HYDRATION_TIMEOUT_MS = 5_000;

/** Whether a late probe result already has a guard re-run waiting on it. */
let probeRevalidationPending = false;

/**
 * Re-run the route guard once a timed-out platform probe reports its result.
 *
 * The timeout decides on a forced `"absent"`, which is the right fallback for
 * an org with no platform account and the wrong one for an org whose probe was
 * merely slow — a paid checkout return is then admitted to billing, which has
 * no managed assistant to apply the purchase to and no way out. Nothing else
 * re-runs middleware on a store change, so the correction has to be driven
 * from here.
 *
 * `platformSession` leaves `"unknown"` at most once (re-probes keep the last
 * settled value), the subscription is one-shot, and the re-run reads a settled
 * session — so it never waits on the probe, never times out, and never arms
 * another re-run.
 */
function revalidateWhenPlatformProbeSettles(): void {
  if (probeRevalidationPending) {
    return;
  }
  probeRevalidationPending = true;
  const unsubscribe = useAuthStore.subscribe((state) => {
    if (state.platformSession === "unknown") {
      return;
    }
    unsubscribe();
    probeRevalidationPending = false;
    // Lazily imported: `@/routes` builds the router out of this middleware, so
    // a static import is a cycle.
    void import("@/routes")
      .then(({ router }) => router.revalidate())
      .catch((error: unknown) => {
        captureError(error, {
          context: "authMiddleware.platformProbeRevalidation",
        });
      });
  });
}

export const authMiddleware: MiddlewareFunction = (args, next) =>
  resolveWithGuard(args, next, false, false);

const resolveWithGuard = async (
  { request, context }: Parameters<MiddlewareFunction>[0],
  next: Parameters<MiddlewareFunction>[1],
  hydrationTimedOut: boolean,
  platformProbeTimedOut: boolean,
): Promise<Awaited<ReturnType<MiddlewareFunction>>> => {
  const url = new URL(request.url);

  // After a timed-out hydration wait, force the hydration flags so the
  // resolver decides on whatever state exists instead of returning another
  // "wait" — a fetch that hangs (never reaching any settle path) must degrade
  // to a decision, not loop navigation in timeout-sized chunks. A platform
  // probe that outran its wait degrades the same way, to `"absent"`: every step
  // that reads the probe treats an unsettled session as "no decision yet" and
  // a settled-absent one as "no platform account", so forcing it can only turn
  // a non-decision into that documented fallback. A result that lands after the
  // timeout re-runs the guard (see `revalidateWhenPlatformProbeSettles`), so a
  // slow-but-successful probe still reaches its platform-session destination.
  //
  // Forcing `consentHydrated` hides that the consent flags underneath it are
  // still their boot `false`, so the forcing itself is reported too: a step
  // that would otherwise read them as a settled "not consented" — and evict a
  // consented user mid-funnel — can fail open on it instead.
  const state = buildNavigationState({
    ...(hydrationTimedOut
      ? {
          consentHydrated: true,
          consentHydrationTimedOut: true,
          assistantsHydrated: true,
        }
      : {}),
    ...(platformProbeTimedOut ? { platformSession: "absent" as const } : {}),
  });

  const decision = resolveNavigation(state, {
    kind: "route-guard",
    pathname: url.pathname + url.search,
  });

  if (decision.action === "wait") {
    await whenStoreState(useAuthStore, (s) => isSessionSettled(s.sessionStatus));
    // Two local-mode cases hang on the platform probe: the cold boot with an
    // empty lockfile, and any step that names the signal on its wait — a
    // checkout return whose org already has a self-hosted assistant reaches
    // the latter with `hasAssistants()` already true.
    let platformProbeStillUnknown = false;
    if (
      !platformProbeTimedOut &&
      isLocalMode() &&
      (!hasAssistants() || decision.waitFor === "platform-session")
    ) {
      await whenStoreState(
        useAuthStore,
        (s) => s.platformSession !== "unknown",
        { timeoutMs: PLATFORM_SESSION_PROBE_TIMEOUT_MS },
      );
      platformProbeStillUnknown =
        useAuthStore.getState().platformSession === "unknown";
      if (platformProbeStillUnknown) {
        revalidateWhenPlatformProbeSettles();
      }
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
      platformProbeTimedOut || platformProbeStillUnknown,
    );
  }

  if (decision.action === "redirect") {
    throw redirect(decision.to);
  }

  context.set(authUserContext, useAuthStore.getState().user);
  return next();
};
