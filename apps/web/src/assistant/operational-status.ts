import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import type { AssistantState } from "@/assistant/types";
import { usePlatformGate } from "@/hooks/use-platform-gate";
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

function canPollOperationalStatus(assistantState: AssistantState): boolean {
  switch (assistantState.kind) {
    case "loading":
    case "initializing":
    case "cleaning_up":
    case "platform_hosted":
    case "error":
      return true;
    case "active":
      return !assistantState.isLocal;
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
  const enabled =
    Boolean(assistantId) &&
    platformHostedGate === "full" &&
    platformApiGate === "full" &&
    canPollOperationalStatus(assistantState);

  return useQuery({
    queryKey: ["assistant-operational-status", assistantId],
    queryFn: () => fetchAssistantOperationalStatus(assistantId!),
    enabled,
    retry: false,
    staleTime: 0,
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      if (!enabled) return false;
      const data = query.state.data;
      if (data === null) return DISABLED_STATUS_POLL_MS;
      return clampPollMs(data?.poll_after_ms);
    },
  });
}

export function isHealthyOperationalStatus(
  status: AssistantOperationalStatus | null | undefined,
): boolean {
  return status?.state === "active";
}
