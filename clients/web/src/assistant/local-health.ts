import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import type { LocalAssistantHealth } from "@/assistant/types";

export type { LocalAssistantHealth } from "@/assistant/types";

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

export function deriveLocalAssistantHealth(
  result: HealthzProbeResult,
): LocalAssistantHealth {
  if (!result.ok) return "unreachable";
  const status = result.data?.status;
  // The daemon reports MIGRATING while its DB migrations run at startup — an
  // expected, self-resolving phase that must render as in-progress, not as an
  // unhealthy warning inviting a mid-migration restart. A terminally failed
  // migration reports ERROR, which falls through to "unhealthy" below.
  if (status === "MIGRATING") {
    return "migrating";
  }
  if (status !== undefined && !HEALTHY_STATUS_VALUES.has(status)) {
    return "unhealthy";
  }
  return "healthy";
}

/**
 * Health of the active local / self-hosted assistant, as maintained by
 * the lifecycle service's healthz heartbeat against the daemon's own
 * health-check API (`/v1/assistants/{id}/healthz`, routed to the user's
 * gateway by the request interceptor). Returns `null` while the signal
 * is unknown — the assistant is platform-hosted (the centralized
 * operational-status API is its health surface), or the first probe
 * hasn't completed yet.
 */
export function useLocalAssistantHealth(): LocalAssistantHealth | null {
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  if (assistantState.kind === "self_hosted") {
    return assistantState.health ?? null;
  }
  if (assistantState.kind === "active" && assistantState.isLocal) {
    return assistantState.health ?? null;
  }
  return null;
}
