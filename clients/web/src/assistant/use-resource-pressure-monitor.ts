import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ResourcePressureStatus } from "@vellumai/assistant-api";

import { getAssistantResourcePressureStatus } from "@/assistant/api";
import {
  RESOURCE_PRESSURE_POLL_INTERVAL_MS,
  areResourcePressureStatusesEqual,
  getResourcePressureMonitorMode,
  type ResourcePressureMonitorMode,
} from "@/assistant/resource-pressure";
import { useBusSubscription } from "@/hooks/use-bus-subscription";

export interface UseResourcePressureMonitorOptions {
  assistantId: string | null;
  enabled: boolean;
  refreshKey?: unknown;
  cadenceMs?: number;
}

export type ResourcePressureStatusEventPayload = ResourcePressureStatus | null;

export interface UseResourcePressureMonitorResult {
  status: ResourcePressureStatus | null;
  mode: ResourcePressureMonitorMode;
  hasResolvedStatus: boolean;
  applyStatusEvent: (payload: ResourcePressureStatusEventPayload) => void;
  refresh: () => Promise<void>;
}

interface ResourcePressureMonitorSnapshot {
  assistantId: string | null;
  status: ResourcePressureStatus | null;
  hasResolvedStatus: boolean;
}

const EMPTY_RESOURCE_PRESSURE_MONITOR_SNAPSHOT: ResourcePressureMonitorSnapshot =
  {
    assistantId: null,
    status: null,
    hasResolvedStatus: false,
  };

export function useResourcePressureMonitor({
  assistantId,
  enabled,
  refreshKey,
  cadenceMs = RESOURCE_PRESSURE_POLL_INTERVAL_MS,
}: UseResourcePressureMonitorOptions): UseResourcePressureMonitorResult {
  const [snapshot, setSnapshot] = useState<ResourcePressureMonitorSnapshot>(
    EMPTY_RESOURCE_PRESSURE_MONITOR_SNAPSHOT,
  );
  const activeAssistantIdRef = useRef<string | null>(assistantId);
  const enabledRef = useRef(enabled);
  const generationRef = useRef(0);
  const pollRequestIdRef = useRef(0);

  useLayoutEffect(() => {
    activeAssistantIdRef.current = assistantId;
    enabledRef.current = enabled;
  });

  useEffect(() => {
    generationRef.current += 1;
    setSnapshot(EMPTY_RESOURCE_PRESSURE_MONITOR_SNAPSHOT);
  }, [assistantId, enabled]);

  const isCurrentRequest = useCallback(
    (requestedAssistantId: string, generation: number) =>
      enabledRef.current &&
      activeAssistantIdRef.current === requestedAssistantId &&
      generationRef.current === generation,
    [],
  );

  const applyStatusForAssistant = useCallback(
    (
      requestedAssistantId: string,
      nextStatus: ResourcePressureStatus | null,
      hasResolvedStatus: boolean,
      generation: number,
    ) => {
      if (!isCurrentRequest(requestedAssistantId, generation)) {
        return;
      }

      setSnapshot((current) => {
        if (
          current.assistantId === requestedAssistantId &&
          current.hasResolvedStatus === hasResolvedStatus &&
          areResourcePressureStatusesEqual(current.status, nextStatus)
        ) {
          return current;
        }

        return {
          assistantId: requestedAssistantId,
          status: nextStatus,
          hasResolvedStatus,
        };
      });
    },
    [isCurrentRequest],
  );

  const clearStatus = useCallback(() => {
    generationRef.current += 1;
    setSnapshot(EMPTY_RESOURCE_PRESSURE_MONITOR_SNAPSHOT);
  }, []);

  const refresh = useCallback(async () => {
    const requestedAssistantId = assistantId;

    if (!enabled || !requestedAssistantId) {
      clearStatus();
      return;
    }

    const generation = generationRef.current;
    const pollRequestId = pollRequestIdRef.current + 1;
    pollRequestIdRef.current = pollRequestId;

    try {
      const result =
        await getAssistantResourcePressureStatus(requestedAssistantId);
      if (pollRequestIdRef.current !== pollRequestId) {
        return;
      }

      if (!result.ok) {
        applyStatusForAssistant(requestedAssistantId, null, false, generation);
        return;
      }

      applyStatusForAssistant(
        requestedAssistantId,
        result.data.status,
        true,
        generation,
      );
    } catch {
      if (pollRequestIdRef.current !== pollRequestId) {
        return;
      }

      applyStatusForAssistant(requestedAssistantId, null, false, generation);
    }
  }, [assistantId, applyStatusForAssistant, clearStatus, enabled]);

  useEffect(() => {
    if (!enabled || !assistantId) {
      return;
    }

    void refresh();

    const intervalId = window.setInterval(() => {
      void refresh();
    }, cadenceMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [assistantId, cadenceMs, enabled, refresh, refreshKey]);

  // The bus's `"app.resume"` channel fans in browser visibility,
  // Capacitor foreground, and `window.online`, so a single
  // subscription drives the focus-style refetch. `refresh` guards
  // on `enabled` and `assistantId` internally.
  useBusSubscription("app.resume", () => {
    void refresh();
  });

  const applyStatusEvent = useCallback(
    (payload: ResourcePressureStatusEventPayload) => {
      if (!enabled || !assistantId) {
        clearStatus();
        return;
      }

      const generation = generationRef.current + 1;
      generationRef.current = generation;
      applyStatusForAssistant(assistantId, payload, true, generation);
    },
    [assistantId, applyStatusForAssistant, clearStatus, enabled],
  );

  // React to daemon-pushed resource pressure events via the event bus.
  // Complements the polling interval and resume-refresh above so
  // status changes are reflected immediately without waiting for
  // the next poll tick.
  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;
    if (event.type !== "resource_pressure_status_changed") {
      return;
    }
    applyStatusEvent(event.status);
  });

  const status =
    enabled && snapshot.assistantId === assistantId ? snapshot.status : null;
  const hasResolvedStatus = Boolean(
    enabled &&
    assistantId &&
    snapshot.assistantId === assistantId &&
    snapshot.hasResolvedStatus,
  );
  const mode = useMemo(() => getResourcePressureMonitorMode(status), [status]);

  return {
    status,
    mode,
    hasResolvedStatus,
    applyStatusEvent,
    refresh,
  };
}
