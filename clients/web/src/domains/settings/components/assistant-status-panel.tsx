import { Loader2 } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type Assistant,
  getAssistant,
  getAssistantHealthz,
} from "@/assistant/api";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { CapacityBar } from "@/domains/settings/components/capacity-bar";
import { DevModeVersionUnlock } from "@/domains/settings/components/dev-mode-version-unlock";
import { healthzGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { HealthzGetResponse } from "@/generated/daemon/types.gen";
import { useOrgHeaderReadiness } from "@/hooks/use-is-org-ready";
import { t, useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { useAuthStore } from "@/stores/auth-store";
import { useEnvironmentStore } from "@/stores/environment-store";
import { isTransientNetworkError } from "@/utils/is-transient-network-error";
import { toast } from "@vellumai/design-library";
import { Tag } from "@vellumai/design-library/components/tag";

const CURRENT_ASSISTANT_QUERY_KEY = "currentAssistant";

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
  /** True while a request is in flight, including a refresh over existing values. */
  healthzFetching: boolean;
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
  const activeAssistantId = useActiveAssistantId();
  const {
    data: assistant = null,
    isLoading: assistantLoading,
    refetch: refetchAssistant,
  } = useQuery({
    queryKey: [CURRENT_ASSISTANT_QUERY_KEY, activeAssistantId],
    queryFn: async () => {
      const result = await getAssistant(activeAssistantId);
      return result.ok ? result.data : null;
    },
    retry: false,
  });
  const queryClient = useQueryClient();
  /* A platform-mode read needs `Vellum-Organization-Id`, which the org store
     hydrates after auth. Without this gate the request can go out headerless
     and be rejected. Ready immediately when there is no platform session, so
     self-hosted and gateway-only sessions are not held up by it. */
  const orgReadiness = useOrgHeaderReadiness();
  /* Keyed on the active id rather than on the resolved record, so this read
     and the record's own go out together. The record can only ever report the
     id the hook already holds, so waiting for it would buy nothing and cost a
     round trip on a tunnel. */
  const healthzQueryOptions = useMemo(
    () => healthzGetOptions({ path: { assistant_id: activeAssistantId } }),
    [activeAssistantId],
  );
  const {
    data: healthz = null,
    isLoading: healthzQueryLoading,
    isFetching: healthzFetching,
    error: healthzError,
    refetch: refetchHealthz,
  } = useQuery({
    ...healthzQueryOptions,
    enabled: orgReadiness === "ready",
    retry: false,
  });
  /* A disabled query reports `isLoading: false`, so the wait for the org
     header would otherwise read as a settled "no metrics" and the cards would
     show their empty dashes on the way to loading. `"resolving"` is that wait
     and belongs with loading; `"unavailable"` is a decided answer, and holding
     a spinner on it would spin for as long as the page is open. */
  const healthzLoading = healthzQueryLoading || orgReadiness === "resolving";

  const [healthzPolling, setHealthzPolling] = useState(false);
  // Bumped to supersede any in-flight resize poll (a new poll, or unmount).
  const pollIdRef = useRef(0);

  /* Transient unreachability is not worth a report: it is what a connection
     blip looks like from here, and the query retries on its own terms.
     Anything else is a real failure of a card the user is looking at. Only
     failures the query publishes reach this, which is why the resize poll
     reads outside it. */
  useEffect(() => {
    if (!healthzError || isTransientNetworkError(healthzError)) {
      return;
    }
    captureError(healthzError, { context: "fetch_assistant_healthz" });
    toast.error(t("settings:assistantStatusPanel.loadHealthzFailed"));
  }, [healthzError]);

  // Cancel any in-flight resize poll when the active assistant changes or the
  // hook unmounts. Without it a poll for the previous assistant keeps running
  // and holds its resize controls disabled. The reported health needs no
  // cleanup: it is cached per assistant id, so a switch reads the new
  // assistant's entry rather than the old one's values.
  useEffect(() => {
    return () => {
      pollIdRef.current += 1;
      setHealthzPolling(false);
    };
  }, [activeAssistantId]);

  /**
   * One reading for the resize poll, taken outside the query on purpose.
   *
   * A resize rolls the pod, so the endpoint is expected to fail for part of
   * the window. Routing those failures through the query would publish them
   * as its error, where they outlive the poll: the error stays on the cache
   * entry, and the next mount of this hook reports a failure the poll had
   * deliberately swallowed. Reading directly keeps a poll failure local to the
   * poll, and a success is written into the cache so the cards follow the
   * resize live.
   */
  const readHealthzOutsideQuery =
    useCallback(async (): Promise<HealthzGetResponse | null> => {
      try {
        const result = await getAssistantHealthz(activeAssistantId);
        if (!result.ok) {
          return null;
        }
        queryClient.setQueryData(healthzQueryOptions.queryKey, result.data);
        return result.data;
      } catch {
        // Unreachable mid-restart. The last good reading stays in the cache,
        // so the cards keep their values instead of blanking.
        return null;
      }
    }, [activeAssistantId, queryClient, healthzQueryOptions]);

  /* The user asked for this one, so it goes through the query: a failure here
     is theirs to see, and the reporting effect above surfaces it. Both reads
     go out together for the same reason the mount path does. */
  const refetch = useCallback(async () => {
    await Promise.all([refetchAssistant(), refetchHealthz()]);
  }, [refetchAssistant, refetchHealthz]);

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
          if (pollId !== pollIdRef.current) {
            return;
          }
          const data = await readHealthzOutsideQuery();
          if (pollId !== pollIdRef.current) {
            return;
          }
          if (!data) {
            continue;
          }
          if (reference == null) {
            reference = data;
            continue;
          }
          if (allocationChanged(data, reference)) {
            return;
          }
        }
      } finally {
        if (pollId === pollIdRef.current) {
          setHealthzPolling(false);
        }
      }
    },
    [readHealthzOutsideQuery, refetchAssistant],
  );

  return {
    assistant,
    assistantLoading,
    healthz,
    healthzLoading,
    healthzFetching,
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

  const { t } = useTranslation("settings");

  if (assistantLoading) {
    return (
      <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("assistantStatusPanel.loading")}
      </div>
    );
  }

  if (!assistant) {
    return (
      <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
        {t("assistantStatusPanel.empty")}
      </p>
    );
  }

  const version = healthz?.version ?? assistant.current_release_version;

  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-3">
      {email && (
        <>
          <Label>{t("assistantStatusPanel.account")}</Label>
          <Value>{email}</Value>
        </>
      )}

      <Label>{t("assistantStatusPanel.name")}</Label>
      <Value>{assistant.name}</Value>

      {assistant.description && (
        <>
          <Label>{t("assistantStatusPanel.description")}</Label>
          <Value>{assistant.description}</Value>
        </>
      )}

      <Label>{t("assistantStatusPanel.status")}</Label>
      <div>
        <Tag tone={assistant.status === "active" ? "positive" : "neutral"}>
          {assistant.status}
        </Tag>
      </div>

      <Label>{t("assistantStatusPanel.assistantId")}</Label>
      <span className="break-all font-mono text-body-small-default text-[var(--content-tertiary)]">
        {assistant.id}
      </span>

      {isNonProduction && assistant.machine_id && (
        <>
          <Label>{t("assistantStatusPanel.machineId")}</Label>
          <span className="break-all font-mono text-body-small-default text-[var(--content-tertiary)]">
            {assistant.machine_id}
          </span>
        </>
      )}

      <Label>{t("assistantStatusPanel.created")}</Label>
      <Value>
        {assistant.created
          ? new Date(assistant.created).toLocaleDateString()
          : t("assistantStatusPanel.unknown")}
      </Value>

      <Label>{t("assistantStatusPanel.version")}</Label>
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
  const { t } = useTranslation("settings");
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-3">
      <Label>{t("assistantStatusPanel.diskUsage")}</Label>
      {healthzLoading ? (
        <LoadingRow label={t("assistantStatusPanel.loadingDisk")} />
      ) : healthz?.disk ? (
        <CapacityBar
          value={healthz.disk.usedMb}
          max={healthz.disk.totalMb}
          caption={t("assistantStatusPanel.usedOf", {
            used: formatResourceMb(healthz.disk.usedMb),
            total: formatResourceMb(healthz.disk.totalMb),
          })}
        />
      ) : (
        <span className="text-[var(--content-tertiary)]">
          {t("assistantStatusPanel.diskUnavailable")}
        </span>
      )}

      <Label>{t("assistantStatusPanel.cpuUsage")}</Label>
      {healthzLoading ? (
        <LoadingRow label={t("assistantStatusPanel.loadingCpu")} />
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

      <Label>{t("assistantStatusPanel.memoryUsage")}</Label>
      {healthzLoading ? (
        <LoadingRow label={t("assistantStatusPanel.loadingMemory")} />
      ) : healthz?.memory ? (
        <CapacityBar
          value={healthz.memory.currentMb}
          max={healthz.memory.maxMb}
          caption={t("assistantStatusPanel.usedOf", {
            used: formatResourceMb(healthz.memory.currentMb),
            total: formatResourceMb(healthz.memory.maxMb),
          })}
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
