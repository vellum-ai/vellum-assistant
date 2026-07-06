/**
 * Operational-status polling for platform-hosted assistants.
 *
 * Uses the generated platform SDK (`assistantsOperationalStatusDetailRead`)
 * for the HTTP call and `assistantsOperationalStatusDetailReadOptions()` for
 * the TanStack Query cache key. The queryFn intentionally treats 403/404 as
 * "no status available" (returns `null`) rather than errors — a 404 means the
 * assistant hasn't been provisioned yet, and 403 means the user's org doesn't
 * own it.
 */

import { useQuery } from "@tanstack/react-query";

import { assistantsOperationalStatusDetailRead } from "@/generated/api/sdk.gen";
import { assistantsOperationalStatusDetailReadOptions } from "@/generated/api/@tanstack/react-query.gen";
import type {
  OperationalStatus,
  OperationalStatusStateEnum,
} from "@/generated/api/types.gen";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import type { AssistantState } from "@/assistant/types";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  useActiveAssistantIsPlatformHosted,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { recordLifecycleDiagnostic } from "@/lib/diagnostics";
import { getSSEConnectedSnapshot } from "@/stores/sse-connected-store";

/** Re-export generated types under their legacy names for consumers. */
export type AssistantOperationalState = OperationalStatusStateEnum;
export type AssistantOperationalStatus = OperationalStatus;

const DEFAULT_STATUS_POLL_MS = 5_000;
const DISABLED_STATUS_POLL_MS = 30_000;
const MIN_STATUS_POLL_MS = 1_000;
const MAX_STATUS_POLL_MS = 30_000;

function clampPollMs(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_STATUS_POLL_MS;
  }
  return Math.min(MAX_STATUS_POLL_MS, Math.max(MIN_STATUS_POLL_MS, value));
}

function canPollOperationalStatus({
  assistantState,
  activeAssistantIsPlatformHosted,
  targetIsLifecycleOperationAssistant,
}: {
  assistantState: AssistantState;
  activeAssistantIsPlatformHosted: boolean;
  targetIsLifecycleOperationAssistant: boolean;
}): boolean {
  if (targetIsLifecycleOperationAssistant) return true;

  switch (assistantState.kind) {
    case "active":
      return activeAssistantIsPlatformHosted;
    default:
      return false;
  }
}

/**
 * Transition dedupe so a steady poll (every 5–30s) doesn't flood the
 * lifecycle ring. We record only when the `state:detail_state` signature
 * changes for a given assistant — one entry per genuine transition.
 */
const lastStatusSignatureByAssistant = new Map<string, string>();

/**
 * Record an operational-status transition into the durable lifecycle
 * diagnostics ring so the support-feedback export captures *why* the
 * banner changed — the platform only returns this over the wire, it is
 * never otherwise persisted client-side, and the assistant pod itself
 * has no knowledge of the control-plane → vembda status query.
 *
 * Crucially, `sseConnected` is the data-plane signal at the instant of
 * the control-plane read: `state: "unreachable"` while SSE is connected
 * is the split-brain fingerprint — the pod's events are flowing, but the
 * status pipeline (control plane → vembda) couldn't confirm reachability
 * (e.g. `detail_state: "vembda_unreachable"`).
 */
function recordOperationalStatusTransition(
  assistantId: string,
  status: OperationalStatus | null,
): void {
  const signature = status
    ? `${status.state}:${status.detail_state ?? ""}`
    : "absent";
  if (lastStatusSignatureByAssistant.get(assistantId) === signature) return;
  lastStatusSignatureByAssistant.set(assistantId, signature);
  recordLifecycleDiagnostic("operational_status", {
    assistantId,
    state: status?.state ?? null,
    detailState: status?.detail_state ?? null,
    reason: status?.detail?.reason ?? null,
    message: status?.detail?.message ?? null,
    healthzOk: status?.runtime?.healthz_ok ?? null,
    podPhase: status?.pod?.pod_phase ?? null,
    sseConnected: getSSEConnectedSnapshot(),
  });
}

/**
 * Fetch operational status, returning `null` for 403 (forbidden) and 404
 * (not found) responses which are expected non-error states.
 */
async function fetchOperationalStatus(
  assistantId: string,
  signal?: AbortSignal,
): Promise<OperationalStatus | null> {
  const { data, error, response } =
    await assistantsOperationalStatusDetailRead({
      path: { id: assistantId },
      signal,
      throwOnError: false,
    });

  if (!response || !response.ok) {
    if (response?.status === 403 || response?.status === 404) {
      recordOperationalStatusTransition(assistantId, null);
      return null;
    }
    throw error ?? new Error("Failed to fetch assistant operational status");
  }

  const status = data ?? null;
  recordOperationalStatusTransition(assistantId, status);
  return status;
}

export function useAssistantOperationalStatus(
  assistantId: string | null,
  opts?: { ignoreActiveAssistantGate?: boolean },
) {
  const platformHostedGate = usePlatformGate({ platformHostedOnly: true });
  const platformApiGate = usePlatformGate();
  const ignoreActiveAssistantGate =
    opts?.ignoreActiveAssistantGate === true;
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const operationalStatusAssistantId =
    useAssistantLifecycleStore.use.operationalStatusAssistantId();
  const activeAssistantIsPlatformHosted = useActiveAssistantIsPlatformHosted();
  const isOrgReady = useIsOrgReady();
  const targetIsLifecycleOperationAssistant =
    Boolean(assistantId) && assistantId === operationalStatusAssistantId;
  const canPollForActiveAssistant =
    ignoreActiveAssistantGate ||
    canPollOperationalStatus({
      assistantState,
      activeAssistantIsPlatformHosted,
      targetIsLifecycleOperationAssistant,
    });
  const enabled =
    Boolean(assistantId) &&
    (ignoreActiveAssistantGate || platformHostedGate === "full") &&
    platformApiGate === "full" &&
    isOrgReady &&
    canPollForActiveAssistant;

  return useQuery({
    queryKey: assistantsOperationalStatusDetailReadOptions({
      path: { id: enabled ? assistantId! : "disabled" },
    }).queryKey,
    queryFn: ({ signal }) => fetchOperationalStatus(assistantId!, signal),
    enabled,
    retry: false,
    staleTime: 0,
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      if (!enabled) return false;
      const data = query.state.data;
      if (data === null) return DISABLED_STATUS_POLL_MS;
      // The server returns a 30s interval for sleeping, but that's too
      // slow to catch the brief "waking" phase when a wake is triggered.
      // Poll at the active rate so the banner transitions promptly.
      if (data?.state === "sleeping") return DEFAULT_STATUS_POLL_MS;
      return clampPollMs(data?.poll_after_ms);
    },
  });
}

export function isHealthyOperationalStatus(
  status: OperationalStatus | null | undefined,
): boolean {
  return status?.state === "active";
}
