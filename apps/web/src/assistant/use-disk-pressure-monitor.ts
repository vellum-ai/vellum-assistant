
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { DiskPressureStatus } from "@vellumai/assistant-api";

import {
  acknowledgeAssistantDiskPressure,
  getAssistantDiskPressureStatus,
} from "@/assistant/api";
import {
  DISK_PRESSURE_POLL_INTERVAL_MS,
  areDiskPressureStatusesEqual,
  getDiskPressureMonitorMode,
  type DiskPressureMonitorMode,
} from "@/assistant/disk-pressure";
import { useBusSubscription } from "@/hooks/use-bus-subscription";

export interface UseDiskPressureMonitorOptions {
  assistantId: string | null;
  enabled: boolean;
  refreshKey?: unknown;
  cadenceMs?: number;
}

export type DiskPressureStatusEventPayload = DiskPressureStatus | null;

export interface UseDiskPressureMonitorResult {
  status: DiskPressureStatus | null;
  mode: DiskPressureMonitorMode;
  hasResolvedStatus: boolean;
  isAcknowledging: boolean;
  acknowledgeError: Error | null;
  acknowledge: () => Promise<void>;
  applyStatusEvent: (payload: DiskPressureStatusEventPayload) => void;
  refresh: () => Promise<void>;
}

interface DiskPressureMonitorSnapshot {
  assistantId: string | null;
  status: DiskPressureStatus | null;
  hasResolvedStatus: boolean;
}

const EMPTY_DISK_PRESSURE_MONITOR_SNAPSHOT: DiskPressureMonitorSnapshot = {
  assistantId: null,
  status: null,
  hasResolvedStatus: false,
};

function errorFromUnknown(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

export function useDiskPressureMonitor({
  assistantId,
  enabled,
  refreshKey,
  cadenceMs = DISK_PRESSURE_POLL_INTERVAL_MS,
}: UseDiskPressureMonitorOptions): UseDiskPressureMonitorResult {
  const [snapshot, setSnapshot] = useState<DiskPressureMonitorSnapshot>(
    EMPTY_DISK_PRESSURE_MONITOR_SNAPSHOT,
  );
  const [isAcknowledging, setIsAcknowledging] = useState(false);
  const [acknowledgeError, setAcknowledgeError] = useState<Error | null>(null);
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
    setSnapshot(EMPTY_DISK_PRESSURE_MONITOR_SNAPSHOT);
    setAcknowledgeError(null);
    setIsAcknowledging(false);
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
      nextStatus: DiskPressureStatus | null,
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
          areDiskPressureStatusesEqual(current.status, nextStatus)
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
    setSnapshot(EMPTY_DISK_PRESSURE_MONITOR_SNAPSHOT);
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
      const result = await getAssistantDiskPressureStatus(requestedAssistantId);
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
    (payload: DiskPressureStatusEventPayload) => {
      if (!enabled || !assistantId) {
        clearStatus();
        return;
      }

      const generation = generationRef.current + 1;
      generationRef.current = generation;
      setIsAcknowledging(false);
      setAcknowledgeError(null);
      applyStatusForAssistant(
        assistantId,
        payload,
        true,
        generation,
      );
    },
    [assistantId, applyStatusForAssistant, clearStatus, enabled],
  );

  // React to daemon-pushed disk pressure events via the event bus.
  // Complements the polling interval and resume-refresh above so
  // status changes are reflected immediately without waiting for
  // the next poll tick.
  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;
    if (event.type !== "disk_pressure_status_changed") return;
    applyStatusEvent(event.status);
  });

  const acknowledge = useCallback(async () => {
    const requestedAssistantId = assistantId;

    if (!enabled || !requestedAssistantId) {
      clearStatus();
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setIsAcknowledging(true);
    setAcknowledgeError(null);

    try {
      const result = await acknowledgeAssistantDiskPressure(
        requestedAssistantId,
      );
      if (!result.ok) {
        throw new Error("Failed to acknowledge assistant disk pressure.");
      }

      if (!isCurrentRequest(requestedAssistantId, generation)) {
        return;
      }

      const applyGeneration = generationRef.current + 1;
      generationRef.current = applyGeneration;
      applyStatusForAssistant(
        requestedAssistantId,
        result.data.status,
        true,
        applyGeneration,
      );
      setIsAcknowledging(false);
    } catch (error) {
      if (isCurrentRequest(requestedAssistantId, generation)) {
        setAcknowledgeError(
          errorFromUnknown(
            error,
            "Failed to acknowledge assistant disk pressure.",
          ),
        );
      }
    } finally {
      if (isCurrentRequest(requestedAssistantId, generation)) {
        setIsAcknowledging(false);
      }
    }
  }, [
    assistantId,
    applyStatusForAssistant,
    clearStatus,
    enabled,
    isCurrentRequest,
  ]);

  const status =
    enabled && snapshot.assistantId === assistantId ? snapshot.status : null;
  const hasResolvedStatus = Boolean(
    enabled &&
      assistantId &&
      snapshot.assistantId === assistantId &&
      snapshot.hasResolvedStatus,
  );
  const mode = useMemo(() => getDiskPressureMonitorMode(status), [status]);

  return {
    status,
    mode,
    hasResolvedStatus,
    isAcknowledging,
    acknowledgeError,
    acknowledge,
    applyStatusEvent,
    refresh,
  };
}
