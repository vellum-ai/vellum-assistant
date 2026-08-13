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
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
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
  targetIsKnownPlatformHostedAssistant,
  targetIsLifecycleOperationAssistant,
}: {
  assistantState: AssistantState;
  activeAssistantIsPlatformHosted: boolean;
  targetIsKnownPlatformHostedAssistant: boolean;
  targetIsLifecycleOperationAssistant: boolean;
}): boolean {
  return (
    targetIsLifecycleOperationAssistant ||
    targetIsKnownPlatformHostedAssistant ||
    (assistantState.kind === "active" && activeAssistantIsPlatformHosted)
  );
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
  if (lastStatusSignatureByAssistant.get(assistantId) === signature) {
    return;
  }
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
  const { data, error, response } = await assistantsOperationalStatusDetailRead(
    {
      path: { id: assistantId },
      signal,
      throwOnError: false,
    },
  );

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

export function useAssistantOperationalStatus(assistantId: string | null) {
  const platformApiGate = usePlatformGate();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const operationalStatusAssistantId =
    useAssistantLifecycleStore.use.operationalStatusAssistantId();
  const targetAssistant = useResolvedAssistantsStore((state) =>
    assistantId
      ? state.assistants.find((assistant) => assistant.id === assistantId)
      : undefined,
  );
  const activeAssistantIsPlatformHosted = useActiveAssistantIsPlatformHosted();
  const isOrgReady = useIsOrgReady();
  const targetIsLifecycleOperationAssistant =
    Boolean(assistantId) && assistantId === operationalStatusAssistantId;
  const targetIsKnownPlatformHostedAssistant =
    targetAssistant?.isPlatformHosted === true &&
    targetAssistant.isLocal === false;
  const enabled =
    Boolean(assistantId) &&
    platformApiGate === "full" &&
    isOrgReady &&
    canPollOperationalStatus({
      assistantState,
      activeAssistantIsPlatformHosted,
      targetIsKnownPlatformHostedAssistant,
      targetIsLifecycleOperationAssistant,
    });

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
      if (!enabled) {
        return false;
      }
      const data = query.state.data;
      if (data === null) {
        return DISABLED_STATUS_POLL_MS;
      }
      // The server returns a 30s interval for sleeping, but that's too
      // slow to catch the brief "waking" phase when a wake is triggered.
      // Poll at the active rate so the banner transitions promptly.
      if (data?.state === "sleeping") {
        return DEFAULT_STATUS_POLL_MS;
      }
      return clampPollMs(data?.poll_after_ms);
    },
  });
}

export function isHealthyOperationalStatus(
  status: OperationalStatus | null | undefined,
): boolean {
  return status?.state === "active";
}

/**
 * Whether the daemon can serve requests in each operational state.
 *
 * Exhaustive over the generated enum, so a state added to the platform schema
 * is a compile error here rather than picking up a silent default. Which way a
 * new state goes is a real decision, and the two mistakes are not symmetric:
 * wrongly closing the gate blanks a working assistant's sidebar until the
 * control plane changes its mind, while wrongly opening it costs one failed
 * request that surfaces with a retry.
 *
 * `unreachable` is open deliberately. It means the control plane could not
 * confirm reachability, which is absence of knowledge rather than evidence the
 * pod is down. `unreachable` while SSE is connected is this module's
 * documented split-brain fingerprint: the pod's events are flowing and its
 * requests succeed while the status pipeline cannot see it (see
 * {@link recordOperationalStatusTransition}).
 */
const DAEMON_SERVES_IN_STATE: Record<OperationalStatusStateEnum, boolean> = {
  active: true,
  unreachable: true,
  waking: false,
  sleeping: false,
  initializing: false,
  provisioning: false,
  migrating: false,
  restarting: false,
  restoring_backup: false,
  upgrading_assistant_version: false,
  resizing_machine: false,
  resizing_storage: false,
  maintenance_mode: false,
  crash_loop: false,
  not_found: false,
  retiring: false,
};

/**
 * Whether data-plane requests to this assistant's daemon should be allowed to
 * run: either the pod is serving, or its health is not knowable from here.
 *
 * The distinction the caller needs is not "healthy" but "not known to be
 * down". Operational status is a platform-only signal: it is `null` for local
 * and self-hosted assistants, for an org whose platform gate is not `"full"`,
 * and for any 403/404, and it is `undefined` until the first poll resolves.
 * Treating any of those as "not serving" would strand every assistant whose
 * health lives somewhere else (`LocalAssistantHealth`, maintained by the
 * lifecycle service's heartbeat probes) behind a signal that will never
 * arrive. So absence opens the gate, and so does a state that carries no
 * verdict; only a state that means the daemon cannot answer closes it.
 *
 * `state: "waking"` is the case this exists for. The daemon 503s every request
 * while the pod warms, and the assistant record stays `status: "active"`
 * throughout, so nothing in {@link AssistantState} can express the difference.
 */
export function isServingOperationalStatus(
  status: OperationalStatus | null | undefined,
): boolean {
  if (status === null || status === undefined) {
    return true;
  }
  // `state` is an open string on the wire, so a value this client's schema
  // predates lands here as `undefined` and opens the gate.
  return DAEMON_SERVES_IN_STATE[status.state] ?? true;
}

/**
 * Gate for queries against the assistant's daemon, true when the pod is
 * serving or its health is unknowable. See
 * {@link isServingOperationalStatus} for why absence opens the gate.
 *
 * Pass this into a query's `enabled` rather than checking it before a manual
 * fetch. A query gated this way stops issuing requests into a wake window
 * (where they 503 and burn the retry budget), and TanStack Query refetches it
 * when the flag flips back to true, which is the edge that carries a sidebar
 * out of a failed load once the pod comes up.
 */
export function useAssistantIsServing(assistantId: string | null): boolean {
  const { data: status } = useAssistantOperationalStatus(assistantId);
  return isServingOperationalStatus(status);
}
