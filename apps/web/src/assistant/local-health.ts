import { useQuery } from "@tanstack/react-query";

import { getAssistantHealthz } from "@/assistant/api";
import { useActiveAssistantIsSelfHosted } from "@/hooks/use-platform-gate";

/**
 * Health of a local assistant as reported by the daemon's own
 * health-check API (`/v1/assistants/{id}/healthz`, routed to the user's
 * gateway by the request interceptor). Platform-hosted assistants report
 * through the centralized operational-status API instead — for them the
 * hook stays disabled and resolves to `null` (no signal).
 */
export type LocalAssistantHealth = "healthy" | "unhealthy" | "unreachable";

const LOCAL_HEALTH_POLL_MS = 5_000;

/**
 * The daemon currently reports `status: "healthy"` from the detailed
 * health endpoint and `status: "ok"` from the basic one; treat both as
 * healthy so a spec regeneration can't flip the banner.
 */
const HEALTHY_STATUS_VALUES = new Set(["healthy", "ok"]);

/**
 * Structural subset of `GetHealthzResult` — keeps the derivation (and
 * its tests) decoupled from the generated daemon response type.
 */
export interface HealthzProbeResult {
  ok: boolean;
  data?: { status?: string };
}

export function deriveLocalAssistantHealth({
  isError,
  result,
}: {
  isError: boolean;
  result: HealthzProbeResult | undefined;
}): LocalAssistantHealth | null {
  if (isError) return "unreachable";
  if (result === undefined) return null;
  if (!result.ok) return "unreachable";
  const status = result.data?.status;
  if (status !== undefined && !HEALTHY_STATUS_VALUES.has(status)) {
    return "unhealthy";
  }
  return "healthy";
}

/**
 * Polls the local assistant's health-check API while the active
 * assistant runs outside the platform (gateway-auth local mode or
 * self-hosted). Returns `null` while the signal is unknown — the
 * assistant is platform-hosted, no assistant is resolved, or the first
 * probe hasn't completed yet.
 */
export function useLocalAssistantHealth(
  assistantId: string | null,
): LocalAssistantHealth | null {
  const isLocal = useActiveAssistantIsSelfHosted();
  const enabled = Boolean(assistantId) && isLocal;

  const query = useQuery({
    // Keep disabled observers off the assistant-specific cache entry so
    // stale unhealthy results cannot render after eligibility flips false.
    queryKey: ["local-assistant-health", enabled ? assistantId : null],
    queryFn: () => getAssistantHealthz(assistantId!),
    enabled,
    retry: false,
    staleTime: 0,
    refetchIntervalInBackground: true,
    refetchInterval: enabled ? LOCAL_HEALTH_POLL_MS : false,
  });

  if (!enabled) return null;
  return deriveLocalAssistantHealth({
    isError: query.isError,
    result: query.data,
  });
}
