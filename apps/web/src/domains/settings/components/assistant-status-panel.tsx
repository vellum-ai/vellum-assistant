import { Loader2 } from "lucide-react";
import {
    type ReactNode,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";

import { useQuery } from "@tanstack/react-query";

import {
    type Assistant,
    getAssistant,
    getAssistantHealthz,
} from "@/assistant/api";
import { CapacityBar } from "@/domains/settings/components/capacity-bar";
import { DevModeVersionUnlock } from "@/domains/settings/components/dev-mode-version-unlock";
import type { HealthzGetResponse } from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useAuthStore } from "@/stores/auth-store";
import { useEnvironmentStore } from "@/stores/environment-store";
import { isTransientNetworkError } from "@/utils/is-transient-network-error";
import { toast } from "@vellumai/design-library";
import { Tag } from "@vellumai/design-library/components/tag";

const CURRENT_ASSISTANT_QUERY_KEY = ["currentAssistant"] as const;

// A resize rolls the assistant pod, so the new allocation only appears once it
// comes back up. Poll /v1/health for a bounded window, tolerating the restart
// gap where the endpoint is briefly unreachable.
const HEALTHZ_POLL_INTERVAL_MS = 4_000;
const HEALTHZ_POLL_TIMEOUT_MS = 90_000;

/**
 * True when the reported CPU/memory allocation differs from `baseline` — i.e.
 * a resize has actually landed.
 */
function allocationChanged(
  next: HealthzGetResponse,
  baseline: HealthzGetResponse,
): boolean {
  return (
    (next.memory?.maxMb ?? null) !== (baseline.memory?.maxMb ?? null) ||
    (next.cpu?.maxCores ?? null) !== (baseline.cpu?.maxCores ?? null)
  );
}

export interface AssistantWithHealthz {
  assistant: Assistant | null;
  assistantLoading: boolean;
  healthz: HealthzGetResponse | null;
  healthzLoading: boolean;
  /** True while a post-resize poll is waiting for the new allocation to appear. */
  healthzPolling: boolean;
  refetch: () => Promise<void>;
  /**
   * Refetch repeatedly until the reported CPU/memory allocation differs from
   * `baseline` (the resize has landed) or a timeout elapses. Tolerates the
   * pod-restart window where /v1/health is briefly unreachable.
   */
  refetchUntilResized: (baseline: HealthzGetResponse | null) => Promise<void>;
}

export function useAssistantWithHealthz(): AssistantWithHealthz {
  const {
    data: assistant = null,
    isLoading: assistantLoading,
    refetch: refetchAssistant,
  } = useQuery({
    queryKey: CURRENT_ASSISTANT_QUERY_KEY,
    queryFn: async () => {
      const result = await getAssistant();
      return result.ok ? result.data : null;
    },
    retry: false,
  });
  const assistantId = assistant?.id;

  const [healthz, setHealthz] = useState<HealthzGetResponse | null>(null);
  const [healthzLoading, setHealthzLoading] = useState(false);
  const [healthzPolling, setHealthzPolling] = useState(false);
  const healthzRequestIdRef = useRef(0);
  // Bumped to supersede any in-flight resize poll (a new poll, or unmount).
  const pollIdRef = useRef(0);

  const fetchHealthz = useCallback(
    async (opts?: {
      keepStaleOnError?: boolean;
    }): Promise<HealthzGetResponse | null> => {
      if (!assistantId) {
        setHealthz(null);
        setHealthzLoading(false);
        return null;
      }
      healthzRequestIdRef.current += 1;
      const requestId = healthzRequestIdRef.current;
      setHealthzLoading(true);
      try {
        const result = await getAssistantHealthz(assistantId);
        if (requestId !== healthzRequestIdRef.current) return null;
        if (result.ok) {
          setHealthz(result.data);
          return result.data;
        }
        // While polling through a resize restart, keep the last-known values
        // rather than blanking the card on a transient non-200.
        if (!opts?.keepStaleOnError) setHealthz(null);
        return null;
      } catch (error) {
        if (requestId !== healthzRequestIdRef.current) return null;
        if (!opts?.keepStaleOnError) setHealthz(null);
        // Transient unreachability during a resize restart is expected — don't
        // report it while polling.
        if (!isTransientNetworkError(error) && !opts?.keepStaleOnError) {
          captureError(error, { context: "fetch_assistant_healthz" });
          toast.error("Failed to load assistant info");
        }
        return null;
      } finally {
        if (requestId === healthzRequestIdRef.current) setHealthzLoading(false);
      }
    },
    [assistantId],
  );

  useEffect(() => {
    void fetchHealthz();
  }, [fetchHealthz]);

  // When the active assistant changes (or on unmount), cancel any in-flight
  // resize poll and drop the previous assistant's cached health. Without the
  // cancel, a poll for the previous assistant keeps writing its data and holds
  // its resize controls disabled; without clearing `healthz`, the cards would
  // render the previous assistant's CPU/memory/disk until the new fetch
  // resolves (both reproducible when switching with multiPlatformAssistant).
  useEffect(() => {
    return () => {
      pollIdRef.current += 1;
      setHealthzPolling(false);
      setHealthz(null);
    };
  }, [assistantId]);

  const refetch = useCallback(async () => {
    await refetchAssistant();
    await fetchHealthz();
  }, [refetchAssistant, fetchHealthz]);

  const refetchUntilResized = useCallback(
    async (baseline: HealthzGetResponse | null) => {
      const pollId = ++pollIdRef.current;
      const deadline = Date.now() + HEALTHZ_POLL_TIMEOUT_MS;
      setHealthzPolling(true);
      // `baseline` is null when metrics weren't loaded yet at resize time. In
      // that case the first reading could still be pre-resize values, so we
      // can't treat it as the resized allocation — adopt it as the baseline and
      // keep polling until it changes instead.
      let reference = baseline;
      try {
        // The machine-size tag comes from the assistant record, which the
        // platform updates synchronously during resize — refresh it up front.
        void refetchAssistant();
        while (Date.now() < deadline && pollId === pollIdRef.current) {
          await new Promise((resolve) =>
            setTimeout(resolve, HEALTHZ_POLL_INTERVAL_MS),
          );
          if (pollId !== pollIdRef.current) return;
          const data = await fetchHealthz({ keepStaleOnError: true });
          if (pollId !== pollIdRef.current) return;
          if (!data) continue;
          if (reference == null) {
            reference = data;
            continue;
          }
          if (allocationChanged(data, reference)) return;
        }
      } finally {
        if (pollId === pollIdRef.current) setHealthzPolling(false);
      }
    },
    [fetchHealthz, refetchAssistant],
  );

  return {
    assistant,
    assistantLoading,
    healthz,
    healthzLoading,
    healthzPolling,
    refetch,
    refetchUntilResized,
  };
}

export interface AssistantStatusPanelProps {
  assistant: Assistant | null;
  assistantLoading: boolean;
  healthz: HealthzGetResponse | null;
  healthzLoading: boolean;
}

export function AssistantStatusPanel({
  assistant,
  assistantLoading,
  healthz,
  healthzLoading,
}: AssistantStatusPanelProps) {
  const isNonProduction = useEnvironmentStore.use.isNonProduction();
  const user = useAuthStore.use.user();
  const email = user?.email;

  if (assistantLoading) {
    return (
      <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading assistant info...
      </div>
    );
  }

  if (!assistant) {
    return (
      <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
        No assistant found. Hatch an assistant to get started.
      </p>
    );
  }

  const version = healthz?.version ?? assistant.current_release_version;

  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-3">
      {email && (
        <>
          <Label>Account</Label>
          <Value>{email}</Value>
        </>
      )}

      <Label>Name</Label>
      <Value>{assistant.name}</Value>

      {assistant.description && (
        <>
          <Label>Description</Label>
          <Value>{assistant.description}</Value>
        </>
      )}

      <Label>Status</Label>
      <div>
        <Tag tone={assistant.status === "active" ? "positive" : "neutral"}>
          {assistant.status}
        </Tag>
      </div>

      <Label>Assistant ID</Label>
      <span className="break-all font-mono text-body-small-default text-[var(--content-tertiary)]">
        {assistant.id}
      </span>

      {isNonProduction && assistant.machine_id && (
        <>
          <Label>Machine ID</Label>
          <span className="break-all font-mono text-body-small-default text-[var(--content-tertiary)]">
            {assistant.machine_id}
          </span>
        </>
      )}

      <Label>Created</Label>
      <Value>
        {assistant.created
          ? new Date(assistant.created).toLocaleDateString()
          : "Unknown"}
      </Value>

      <Label>Version</Label>
      <DevModeVersionUnlock
        version={version ?? null}
        loading={healthzLoading && !assistant.current_release_version}
        assistantId={assistant.id ?? null}
      />
    </div>
  );
}

export interface SystemResourcesPanelProps {
  healthz: HealthzGetResponse | null;
  healthzLoading: boolean;
}

export function SystemResourcesPanel({
  healthz,
  healthzLoading,
}: SystemResourcesPanelProps) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-3">
      <Label>Disk Usage</Label>
      {healthzLoading ? (
        <LoadingRow label="Loading disk status..." />
      ) : healthz?.disk ? (
        <CapacityBar
          value={healthz.disk.usedMb}
          max={healthz.disk.totalMb}
          caption={`${formatResourceMb(healthz.disk.usedMb)} used of ${formatResourceMb(healthz.disk.totalMb)}`}
        />
      ) : (
        <span className="text-[var(--content-tertiary)]">
          Disk status unavailable
        </span>
      )}

      <Label>CPU Usage</Label>
      {healthzLoading ? (
        <LoadingRow label="Loading CPU status..." />
      ) : healthz?.cpu ? (
        <CapacityBar
          value={healthz.cpu.currentPercent}
          max={100}
          caption={`${healthz.cpu.currentPercent.toFixed(1)}%`}
        />
      ) : (
        <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
          —
        </span>
      )}

      <Label>Memory Usage</Label>
      {healthzLoading ? (
        <LoadingRow label="Loading memory status..." />
      ) : healthz?.memory ? (
        <CapacityBar
          value={healthz.memory.currentMb}
          max={healthz.memory.maxMb}
          caption={`${formatResourceMb(healthz.memory.currentMb)} used of ${formatResourceMb(healthz.memory.maxMb)}`}
        />
      ) : (
        <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
          —
        </span>
      )}
    </div>
  );
}

export function formatResourceMb(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${mb.toFixed(0)} MB`;
}

function Label({ children }: { children: ReactNode }) {
  return (
    <span className="text-body-medium-default text-[var(--content-tertiary)]">
      {children}
    </span>
  );
}

function Value({ children }: { children: ReactNode }) {
  return (
    <span className="text-body-medium-lighter text-[var(--content-default)]">
      {children}
    </span>
  );
}

function LoadingRow({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </span>
  );
}
