import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import type { AssistantState } from "@/assistant/types";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  useActiveAssistantIsPlatformHosted,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export type AssistantOperationalState =
  | "initializing"
  | "provisioning"
  | "active"
  | "sleeping"
  | "waking"
  | "restarting"
  | "restoring_backup"
  | "upgrading_assistant_version"
  | "resizing_machine"
  | "resizing_storage"
  | "maintenance_mode"
  | "crash_loop"
  | "unreachable"
  | "not_found"
  | "retiring";

export interface AssistantOperationalStatus {
  state: AssistantOperationalState;
  detail_state: string | null;
  poll_after_ms: number | null;
  updated_at: string;
  active_operation: {
    operation: string;
    operation_id: string;
    phase: string;
    started_at: string;
    updated_at: string;
    target: Record<string, unknown>;
  } | null;
  detail?: {
    reason?: string | null;
    message?: string | null;
  } | null;
}

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

export async function fetchAssistantOperationalStatus(
  assistantId: string,
): Promise<AssistantOperationalStatus | null> {
  const { data, error, response } = await client.get<
    AssistantOperationalStatus,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/operational/status/",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });

  assertHasResponse(response, error, "Failed to fetch assistant status.");

  if (response.status === 403 || response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to fetch assistant status."),
    );
  }

  return data ?? null;
}

export function useAssistantOperationalStatus(assistantId: string | null) {
  const platformHostedGate = usePlatformGate({ platformHostedOnly: true });
  const platformApiGate = usePlatformGate();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const operationalStatusAssistantId =
    useAssistantLifecycleStore.use.operationalStatusAssistantId();
  const activeAssistantIsPlatformHosted = useActiveAssistantIsPlatformHosted();
  const isOrgReady = useIsOrgReady();
  const targetIsLifecycleOperationAssistant =
    Boolean(assistantId) && assistantId === operationalStatusAssistantId;
  const enabled =
    Boolean(assistantId) &&
    platformHostedGate === "full" &&
    platformApiGate === "full" &&
    isOrgReady &&
    canPollOperationalStatus({
      assistantState,
      activeAssistantIsPlatformHosted,
      targetIsLifecycleOperationAssistant,
    });

  return useQuery({
    // Keep disabled observers off the assistant-specific cache entry so
    // stale unhealthy status cannot render after eligibility flips false.
    queryKey: ["assistant-operational-status", enabled ? assistantId : null],
    queryFn: () => fetchAssistantOperationalStatus(assistantId!),
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
  status: AssistantOperationalStatus | null | undefined,
): boolean {
  return status?.state === "active";
}
