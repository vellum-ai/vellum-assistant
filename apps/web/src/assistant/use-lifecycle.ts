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
import { resolveSelectedAssistantId } from "@/assistant/selection";
import { isGatewayAuthMode } from "@/lib/auth/gateway-session";
import { getLocalAssistants, isLocalMode } from "@/lib/local-mode";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { isAuthenticated, type SessionStatus } from "@/stores/session-status";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useOrganizationStore } from "@/stores/organization-store";

interface UseAssistantLifecycleOptions {
  sessionStatus: SessionStatus;
  hasPlatformSession: boolean;
}

export function useAssistantLifecycle({
  sessionStatus,
  hasPlatformSession,
}: UseAssistantLifecycleOptions): void {
  const queryClient = useQueryClient();

  const isOrgReady = useIsOrgReady();
  const currentOrganizationId =
    useOrganizationStore.use.currentOrganizationId();

  // Whether to query the server-side status at all. Gateway-auth
  // mode and "local mode without platform session" short-circuit
  // to local states without ever calling /assistant/.
  // Platform API calls require the Vellum-Organization-Id header;
  // wait for the org store to resolve before firing them.
  const shouldQueryServer =
    isAuthenticated(sessionStatus) &&
    !isGatewayAuthMode() &&
    (hasPlatformSession || !isLocalMode()) &&
    isOrgReady;

  // Which platform assistant the user has selected, gated by the
  // multi-platform-assistant flag. When the flag is off this stays null,
  // so the resolution falls back to the default first-listed assistant —
  // identical to the pre-multi-assistant behavior. Subscribe to the selection
  // and resolved list so the hook re-renders when either changes, then
  // resolve through the unified resolver (selected id → validate for org
  // → lockfile activeAssistant → first valid).
  const multiAssistantEnabled =
    useClientFeatureFlagStore.use.multiPlatformAssistant();
  useResolvedAssistantsStore.use.selectedAssistantId();
  // Subscribe so the hook re-renders (and the lockfile-local check below
  // re-evaluates) when the resolved list / lockfile change.
  useResolvedAssistantsStore.use.assistants();
  const resolvedSelectionId =
    multiAssistantEnabled && !isGatewayAuthMode() && currentOrganizationId
      ? resolveSelectedAssistantId(currentOrganizationId)
      : null;
  // Keep only lockfile-only LOCAL assistants off the platform retrieve path:
  // they're gateway-based, never registered on the platform, so getAssistant(id)
  // 404s. Managed AND platform self-hosted (API `is_local`) assistants ARE valid
  // there — the lifecycle's projectSelfHosted handles the self-hosted response —
  // and a pre-hydration unknown id passes through for the 404 net.
  const selectedPlatformAssistantId =
    resolvedSelectionId &&
    !getLocalAssistants().some((a) => a.assistantId === resolvedSelectionId)
      ? resolvedSelectionId
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
      hasPlatformSession,
      queryClient,
      selectedPlatformAssistantId,
      isOrgReady,
    });
    void lifecycleService.respondToInputs();
  }, [
    sessionStatus,
    hasPlatformSession,
    queryClient,
    selectedPlatformAssistantId,
    isOrgReady,
  ]);

  // Hand poll results to the service — it decides whether to
  // project them (only while the lifecycle is transient).
  useEffect(() => {
    if (!assistantResult) return;
    void lifecycleService.applyServerResult(assistantResult);
  }, [assistantResult]);
}
