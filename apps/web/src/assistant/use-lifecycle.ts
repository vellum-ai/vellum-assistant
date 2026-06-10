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
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { isAuthenticated, type SessionStatus } from "@/stores/session-status";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import {
  assistantsValidForOrg,
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";
import { useOrganizationStore } from "@/stores/organization-store";

interface UseAssistantLifecycleOptions {
  sessionStatus: SessionStatus;
  hasPlatformSession: boolean;
}

/**
 * Drop a per-org selection the resolved list already shows is wrong-org.
 * A candidate is kept if it has no resolved entry yet (unknown id — let
 * the 404 net handle it) or its entry survives `assistantsValidForOrg`.
 * A known entry owned by a different org resolves to null up front.
 */
export function resolveSelectedPlatformAssistantId(
  candidateId: string | null,
  assistants: ResolvedAssistant[],
  currentOrganizationId: string | null,
): string | null {
  if (candidateId === null) return null;
  const entry = assistants.find((a) => a.id === candidateId);
  if (!entry) return candidateId;
  const valid = assistantsValidForOrg(assistants, currentOrganizationId);
  return valid.some((a) => a.id === candidateId) ? candidateId : null;
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
  // multi-platform-assistant flag. When the flag is off (or no
  // selection) this stays null, so the resolution falls back to the
  // default first-listed assistant — identical to the
  // pre-multi-assistant behavior.
  const multiAssistantEnabled =
    useClientFeatureFlagStore.use.multiPlatformAssistant();
  const byOrg =
    useResolvedAssistantsStore.use.selectedPlatformAssistantByOrg();
  const assistants = useResolvedAssistantsStore.use.assistants();
  const candidatePlatformAssistantId =
    multiAssistantEnabled &&
    !isGatewayAuthMode() &&
    currentOrganizationId
      ? (byOrg[currentOrganizationId] ?? null)
      : null;
  // A selection the resolved list already attributes to another org is
  // dropped here, before the API can 404 on it.
  const selectedPlatformAssistantId = resolveSelectedPlatformAssistantId(
    candidatePlatformAssistantId,
    assistants,
    currentOrganizationId,
  );

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
