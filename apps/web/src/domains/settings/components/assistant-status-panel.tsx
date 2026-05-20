import { Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { Tag } from "@vellum/design-library/components/tag";
import { CapacityBar } from "@/domains/settings/components/capacity-bar.js";
import {
  type Assistant,
  type AssistantHealthz,
  getAssistant,
  getAssistantHealthz,
} from "@/domains/assistant/api.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { reportError } from "@/lib/errors/report.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/app.js";

const CURRENT_ASSISTANT_QUERY_KEY = ["currentAssistant"] as const;

export interface AssistantWithHealthz {
  assistant: Assistant | null;
  assistantLoading: boolean;
  healthz: AssistantHealthz | null;
  healthzLoading: boolean;
  refetch: () => Promise<void>;
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

  const [healthz, setHealthz] = useState<AssistantHealthz | null>(null);
  const [healthzLoading, setHealthzLoading] = useState(false);
  const healthzRequestIdRef = useRef(0);

  const fetchHealthz = useCallback(async () => {
    if (!assistantId) {
      setHealthz(null);
      setHealthzLoading(false);
      return;
    }
    healthzRequestIdRef.current += 1;
    const requestId = healthzRequestIdRef.current;
    setHealthzLoading(true);
    try {
      const result = await getAssistantHealthz(assistantId);
      if (requestId !== healthzRequestIdRef.current) return;
      setHealthz(result.ok ? result.data : null);
    } catch (error) {
      if (requestId !== healthzRequestIdRef.current) return;
      setHealthz(null);
      const isNetworkError =
        error instanceof TypeError &&
        /failed to fetch|load failed|networkerror/i.test(error.message);
      if (!isNetworkError) {
        reportError(error, {
          context: "fetch_assistant_healthz",
          userMessage: "Failed to load assistant info",
        });
      }
    } finally {
      if (requestId === healthzRequestIdRef.current) setHealthzLoading(false);
    }
  }, [assistantId]);

  useEffect(() => {
    void fetchHealthz();
  }, [fetchHealthz]);

  const refetch = useCallback(async () => {
    await refetchAssistant();
    await fetchHealthz();
  }, [refetchAssistant, fetchHealthz]);

  return { assistant, assistantLoading, healthz, healthzLoading, refetch };
}

export interface AssistantStatusPanelProps {
  assistant: Assistant | null;
  assistantLoading: boolean;
  healthz: AssistantHealthz | null;
  healthzLoading: boolean;
}

export function AssistantStatusPanel({
  assistant,
  assistantLoading,
  healthz,
  healthzLoading,
}: AssistantStatusPanelProps) {
  const { isNonProduction } = useAppFeatureFlags();
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
      <Value>{new Date(assistant.created).toLocaleDateString()}</Value>

      <Label>Version</Label>
      {healthzLoading && !assistant.current_release_version ? (
        <span className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading version...
        </span>
      ) : version ? (
        <span className="break-all text-body-medium-lighter text-[var(--content-default)]">
          {version}
        </span>
      ) : (
        <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
          —
        </span>
      )}
    </div>
  );
}

export interface SystemResourcesPanelProps {
  healthz: AssistantHealthz | null;
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
