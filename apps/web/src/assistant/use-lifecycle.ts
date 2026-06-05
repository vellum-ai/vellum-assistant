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
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useCurrentPlatformAssistantStore } from "@/stores/current-platform-assistant-store";
import { useOrganizationStore } from "@/stores/organization-store";

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

  // Which platform assistant the user has selected, gated by the
  // multi-platform-assistant flag and to platform mode only. When the flag
  // is off (or no selection / not platform mode) this stays null, so the
  // resolution falls back to the default first-listed assistant — identical
  // to the pre-multi-assistant behavior. A change here flows into the
  // service via `setInputs` → `respondToInputs` → `checkAssistant`, which
  // re-resolves and projects the newly selected assistant.
  const multiAssistantEnabled =
    useAssistantFeatureFlagStore.use.multiPlatformAssistant();
  const currentOrganizationId =
    useOrganizationStore.use.currentOrganizationId();
  const byOrg = useCurrentPlatformAssistantStore.use.byOrg();
  const selectedPlatformAssistantId =
    multiAssistantEnabled &&
    !isGatewayAuthMode() &&
    !isLocalMode() &&
    currentOrganizationId
      ? (byOrg[currentOrganizationId] ?? null)
      : null;

  const { data: assistantResult } = useAssistantQuery({
    enabled: shouldQueryServer,
    selectedPlatformAssistantId,
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
      selectedPlatformAssistantId,
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
    selectedPlatformAssistantId,
  ]);

  // Hand poll results to the service — it decides whether to
  // project them (only while the lifecycle is transient).
  useEffect(() => {
    if (!assistantResult) return;
    void lifecycleService.applyServerResult(assistantResult);
  }, [assistantResult]);
}
