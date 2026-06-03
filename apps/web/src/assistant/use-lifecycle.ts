/**
 * Wires React lifecycle into the non-React lifecycle service.
 *
 * The state machine itself lives in `lifecycle-service.ts` — a
 * module-level singleton that owns retry budgets, recovery timers,
 * the generation counter, and all the state transitions. This hook
 * only does the React-bound work: pull the auth/env signals out of
 * their Zustand stores, pull the TanStack Query client and the
 * `/assistant/` poll result out of the React tree, and push them
 * into the service.
 *
 * Mount this once at the application root (`RootLayout`).
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { lifecycleService } from "@/assistant/lifecycle-service";
import { useAssistantQuery } from "@/assistant/queries";
import { isGatewayAuthMode } from "@/lib/auth/gateway-session";
import { isLocalMode } from "@/lib/local-mode";
import { isAuthenticated, type SessionStatus } from "@/stores/session-status";

interface UseAssistantLifecycleOptions {
  sessionStatus: SessionStatus;
  isRetired: boolean;
  isNonProduction: boolean;
  hasPlatformSession: boolean;
  /** Framework-agnostic redirect — called instead of router.replace(). */
  onRedirect: (url: string) => void;
  /**
   * Returns the path to redirect to when onboarding should intercept,
   * or `null` if the intended destination is fine as-is. Injected so
   * `assistant/` stays free of the onboarding domain (the
   * `shared → domains` direction).
   */
  resolveOnboardingRedirect: (input: {
    intendedDestination: string;
  }) => string | null;
}

export function useAssistantLifecycle({
  sessionStatus,
  isRetired,
  isNonProduction,
  hasPlatformSession,
  onRedirect,
  resolveOnboardingRedirect,
}: UseAssistantLifecycleOptions): void {
  const queryClient = useQueryClient();

  // Whether to query the server-side status at all. Gateway-auth
  // mode and "local mode without platform session" short-circuit
  // to local states without ever calling /assistant/.
  const shouldQueryServer =
    isAuthenticated(sessionStatus) &&
    !isGatewayAuthMode() &&
    (hasPlatformSession || !isLocalMode());

  const { data: assistantResult } = useAssistantQuery({
    enabled: shouldQueryServer,
  });

  // Push inputs into the service and let it react. The service is a
  // singleton so the React tree's render cadence is just a feeder
  // for `setInputs` / `respondToInputs` — no state lives in the
  // hook itself.
  useEffect(() => {
    lifecycleService.setInputs({
      sessionStatus,
      isRetired,
      isNonProduction,
      hasPlatformSession,
      onRedirect,
      resolveOnboardingRedirect,
      queryClient,
    });
    void lifecycleService.respondToInputs();
  }, [
    sessionStatus,
    isRetired,
    isNonProduction,
    hasPlatformSession,
    onRedirect,
    resolveOnboardingRedirect,
    queryClient,
  ]);

  // Hand poll results to the service — it decides whether to
  // project them (only while the lifecycle is transient).
  useEffect(() => {
    if (!assistantResult) return;
    void lifecycleService.applyServerResult(assistantResult);
  }, [assistantResult]);
}
