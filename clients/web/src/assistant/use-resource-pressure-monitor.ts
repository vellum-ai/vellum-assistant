import type { ResourcePressureStatus } from "@vellumai/assistant-api";

import { getAssistantResourcePressureStatus } from "@/assistant/api";
import {
  RESOURCE_PRESSURE_POLL_INTERVAL_MS,
  areResourcePressureStatusesEqual,
  getResourcePressureMonitorMode,
  type ResourcePressureMonitorMode,
} from "@/assistant/resource-pressure";
import { useAssistantStatusMonitor } from "@/assistant/use-assistant-status-monitor";

export interface UseResourcePressureMonitorOptions {
  assistantId: string | null;
  enabled: boolean;
}

export interface UseResourcePressureMonitorResult {
  status: ResourcePressureStatus | null;
  mode: ResourcePressureMonitorMode;
}

export function useResourcePressureMonitor({
  assistantId,
  enabled,
}: UseResourcePressureMonitorOptions): UseResourcePressureMonitorResult {
  const { status, mode } = useAssistantStatusMonitor({
    assistantId,
    enabled,
    cadenceMs: RESOURCE_PRESSURE_POLL_INTERVAL_MS,
    fetchStatus: getAssistantResourcePressureStatus,
    areStatusesEqual: areResourcePressureStatusesEqual,
    deriveMode: getResourcePressureMonitorMode,
    extractSseStatus: (event) =>
      event.type === "resource_pressure_status_changed"
        ? event.status
        : undefined,
  });

  return { status, mode };
}
