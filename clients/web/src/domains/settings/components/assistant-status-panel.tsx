import { Loader2 } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useQuery } from "@tanstack/react-query";

import { type Assistant, getAssistant } from "@/assistant/api";
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

/** What a post-resize watch is waiting for. */
export interface ResizeWatch {
  /**
   * The allocation to watch for a change from. Null when nothing had loaded
   * when the resize started: the first reading after that could still be the
   * pre-resize values, so it is adopted as the baseline rather than read as
   * the resized allocation.
   */
  baseline: HealthzGetResponse | null;
  /** Wall clock. The watch ends here whether or not the allocation moved. */
  until: number;
}

/**
 * The health query's `refetchInterval` decision: the cadence to poll at, or
 * `false` to stop.
 *
 * At module scope so the tests exercise the same code path the runtime does.
 * A copy of this rule in a test helper would let the two drift.
 */
export function resizePollInterval(
  data: HealthzGetResponse | undefined,
  watch: ResizeWatch | null,
  now: number,
): number | false {
  if (watch === null || now >= watch.until) {
    return false;
  }
  if (data === undefined || watch.baseline === null) {
    return HEALTHZ_POLL_INTERVAL_MS;
  }
  return allocationChanged(data, watch.baseline)
    ? false
    : HEALTHZ_POLL_INTERVAL_MS;
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
   * Watch for the reported CPU/memory allocation to differ from `baseline`,
   * meaning the resize has landed. The health query polls while the watch is
   * open and stops on its own once the allocation moves or the window
   * elapses, tolerating the pod restart where /v1/health is unreachable.
   */
  refetchUntilResized: (baseline: HealthzGetResponse | null) => void;
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
  const [resizeWatch, setResizeWatch] = useState<ResizeWatch | null>(null);
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
    /* Live readings, so a revisit revalidates rather than serving a frozen
       number. The cache is here to paint the last values immediately, not to
       stand in for a fresh one. */
    staleTime: 0,
    /* A resize rolls the pod, so the new allocation only appears once it comes
       back. The query owns that cadence: it already retries nothing, keeps the
       last good data across a failed attempt, and stops on its own when the
       allocation moves. */
    refetchInterval: (query) =>
      resizePollInterval(query.state.data, resizeWatch, Date.now()),
  });
  /* A disabled query reports `isLoading: false`, so the wait for the org
     header would otherwise read as a settled "no metrics" and the cards would
     show their empty dashes on the way to loading. `"resolving"` is that wait
     and belongs with loading; `"unavailable"` is a decided answer, and holding
     a spinner on it would spin for as long as the page is open. */
  const healthzLoading = healthzQueryLoading || orgReadiness === "resolving";

  const healthzPolling = resizeWatch !== null;

  /* Reported only when there is nothing to show. A failure with values still
     on the cards is not worth interrupting for: the last reading stands as the
     truth of when it was taken, and a resize deliberately spends part of its
     window unreachable. Keyed on the error and the data rather than on whether
     a poll is running, so there is no flag whose flip can surface a failure
     after the fact. */
  useEffect(() => {
    if (healthzError === null || healthz !== null) {
      return;
    }
    if (isTransientNetworkError(healthzError)) {
      return;
    }
    captureError(healthzError, { context: "fetch_assistant_healthz" });
    toast.error(t("settings:assistantStatusPanel.loadHealthzFailed"));
  }, [healthzError, healthz]);

  /* Ends the watch, and adopts a baseline for a resize that started before any
     reading arrived. The cadence is the query's; this owns only when the watch
     is over, which is the allocation moving or the deadline passing. */
  useEffect(() => {
    if (resizeWatch === null) {
      return;
    }
    if (resizeWatch.baseline === null && healthz !== null) {
      setResizeWatch({ ...resizeWatch, baseline: healthz });
      return;
    }
    if (
      resizePollInterval(healthz ?? undefined, resizeWatch, Date.now()) ===
      false
    ) {
      setResizeWatch(null);
      return;
    }
    const timer = setTimeout(
      () => setResizeWatch(null),
      Math.max(0, resizeWatch.until - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [resizeWatch, healthz]);

  /* A watch belongs to the assistant that was resized. The reported health
     needs no cleanup of its own, being cached per assistant id, but a watch
     left running would hold the next assistant's resize controls disabled. */
  useEffect(() => {
    setResizeWatch(null);
  }, [activeAssistantId]);

  const refetch = useCallback(async () => {
    await Promise.all([refetchAssistant(), refetchHealthz()]);
  }, [refetchAssistant, refetchHealthz]);

  /* Opens the watch; the query polls from there. The machine-size tag comes
     from the assistant record, which the platform updates synchronously during
     a resize, so that one is refreshed up front. */
  const refetchUntilResized = useCallback(
    (baseline: HealthzGetResponse | null) => {
      void refetchAssistant();
      setResizeWatch({ baseline, until: Date.now() + HEALTHZ_POLL_TIMEOUT_MS });
    },
    [refetchAssistant],
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
