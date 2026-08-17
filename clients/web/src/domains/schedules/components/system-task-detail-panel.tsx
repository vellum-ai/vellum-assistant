import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2, Play, Settings } from "lucide-react";
import { useNavigate } from "react-router";

import { DetailShellHeader } from "@/components/detail-shell";
import { InsetDetailCard } from "@/components/inset-detail-card";
import { useTranslation } from "@/i18n";
import { SCHEDULE_RUNS_PAGE_SIZE } from "@/domains/settings/api/schedules";
import { ModelProfileRow } from "@/domains/settings/components/model-profile-row";
import { RecentRunsCard } from "@/domains/settings/components/recent-runs-card";
import {
  consolidationSubtitle,
  flattenRunPages,
  formatTimestamp,
  heartbeatSubtitle,
  isBookkeepingRun,
  isExecutedRun,
  RETROSPECTIVE_SUBTITLE,
} from "@/domains/settings/utils/schedule-formatters";
import { toScheduleRun } from "@/domains/settings/utils/system-task-run-transforms";
import {
  consolidationRunsGetInfiniteOptions,
  heartbeatRunsGetInfiniteOptions,
  retrospectiveRunsGetInfiniteOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library";
import { Notice } from "@vellumai/design-library/components/notice";
import { Toggle } from "@vellumai/design-library/components/toggle";

import type { ReactNode } from "react";

import type { SystemTaskKind } from "@/domains/settings/types/schedules";
import type { ResolvableCallSite } from "@/hooks/use-call-site-default-profile";

// Each system task resolves its model from a dedicated LLM call site.
const SYSTEM_TASK_PROFILE_CALL_SITES: Record<
  SystemTaskKind,
  ResolvableCallSite
> = {
  heartbeat: "heartbeatAgent",
  consolidation: "memoryV2Consolidation",
  retrospective: "memoryRetrospective",
};

/**
 * One label/value line in the Details card. `min-h-6` pins every row to 24px
 * whatever sits in the value slot, so the 16px toggle on Status and the plain
 * text on the other rows keep one rhythm. The value slot is itself a flex row
 * so a control can sit beside its text.
 */
function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-4">
      <span className="shrink-0 text-[var(--content-secondary)]">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-2 text-right text-[var(--content-default)]">
        {value}
      </span>
    </div>
  );
}

type SystemTasksData = ReturnType<
  typeof import("@/domains/settings/hooks/use-system-tasks").useSystemTasks
>;

export interface SystemTaskDetailPanelProps {
  kind: SystemTaskKind;
  assistantId: string;
  systemTasks: SystemTasksData;
  canOpenMemorySettings: boolean;
  onClose: () => void;
}

/**
 * Inline detail for a built-in system task (heartbeat, consolidation, memory
 * retrospective) shown in the Schedules page right pane. Mirrors `ScheduleDetailPanel`'s
 * chrome so system and user schedules share one side-panel UX, while reusing
 * the system-task config/runs/mutations from `useSystemTasks`.
 */
export function SystemTaskDetailPanel({
  kind,
  assistantId,
  systemTasks,
  canOpenMemorySettings,
  onClose,
}: SystemTaskDetailPanelProps) {
  const { t } = useTranslation("schedules");
  const navigate = useNavigate();
  const { heartbeatConfig, consolidationConfig, retrospectiveConfig } =
    systemTasks;

  let name: string;
  let subtitle: string;
  let enabled: boolean;
  let nextRunAt: number | null;
  let lastRunAt: number | null;
  let isRunning: boolean;
  let onRunNow: (() => void) | undefined;

  if (kind === "heartbeat") {
    name = t("systemTaskDetail.nameHeartbeat");
    subtitle = heartbeatConfig ? heartbeatSubtitle(heartbeatConfig) : "";
    enabled = heartbeatConfig?.enabled ?? false;
    nextRunAt = heartbeatConfig?.nextRunAt ?? null;
    lastRunAt = heartbeatConfig?.lastRunAt ?? null;
    isRunning = systemTasks.isHeartbeatRunning;
    onRunNow = systemTasks.runHeartbeatNow;
  } else if (kind === "consolidation") {
    name = t("systemTaskDetail.nameConsolidation");
    subtitle = consolidationConfig
      ? consolidationSubtitle(consolidationConfig)
      : "";
    enabled = consolidationConfig?.enabled ?? false;
    nextRunAt = consolidationConfig?.nextRunAt ?? null;
    lastRunAt = consolidationConfig?.lastRunAt ?? null;
    isRunning = systemTasks.isConsolidationRunning;
    onRunNow = systemTasks.runConsolidationNow;
  } else {
    name = t("systemTaskDetail.nameRetrospective");
    subtitle = RETROSPECTIVE_SUBTITLE;
    enabled = retrospectiveConfig?.enabled ?? false;
    // Event-driven: no global "next run".
    nextRunAt = retrospectiveConfig?.nextRunAt ?? null;
    lastRunAt = retrospectiveConfig?.lastRunAt ?? null;
    isRunning = false;
    onRunNow = undefined;
  }

  // Consolidation and retrospective are owned by Memory: no toggle in this
  // panel, paused when Memory is off. Retrospective additionally has no global
  // schedule (so it hides Next run) and its own persisted switch
  // (`memory.retrospective.enabled`), which pauses it while Memory stays on.
  // `available` is what tells the two pauses apart, and each pause sends the
  // user to the control that actually unpauses it.
  const isMemoryManaged = kind !== "heartbeat";
  const isRetrospective = kind === "retrospective";
  const isMemoryPaused = isMemoryManaged && !enabled;
  const runNowDisabled = isRunning || isMemoryPaused;
  const statusValue = isMemoryManaged
    ? enabled
      ? t("systemTaskDetail.statusManagedOn")
      : t("systemTaskDetail.statusPaused")
    : enabled
      ? t("scheduleDetail.enabled")
      : t("scheduleDetail.disabled");
  const isRetrospectiveSwitchedOff =
    isRetrospective && retrospectiveConfig?.available === true;
  const pausedNotice = isRetrospectiveSwitchedOff
    ? t("systemTaskDetail.pausedRetrospectiveSwitchedOff")
    : isRetrospective
      ? t("systemTaskDetail.pausedRetrospective")
      : t("systemTaskDetail.pausedConsolidation");
  const showMemorySettings =
    isMemoryManaged && enabled && canOpenMemorySettings;

  const opts = {
    path: { assistant_id: assistantId },
    query: { limit: SCHEDULE_RUNS_PAGE_SIZE },
  };

  // Extract queryKey/queryFn individually — spreading the full options union
  // triggers TS2769 because the three generated option types have subtly
  // different `enabled` callback generics that don't unify.
  const infiniteOpts =
    kind === "heartbeat"
      ? heartbeatRunsGetInfiniteOptions(opts)
      : kind === "consolidation"
        ? consolidationRunsGetInfiniteOptions(opts)
        : retrospectiveRunsGetInfiniteOptions(opts);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: infiniteOpts.queryKey,
      queryFn: infiniteOpts.queryFn,
      initialPageParam: { path: opts.path, query: {} },
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      staleTime: 10_000,
    });
  const runs = flattenRunPages(
    data?.pages.map((page) => ({
      runs: page.runs
        .filter((run) => !isBookkeepingRun(run))
        .map((run) => toScheduleRun(run, kind)),
    })),
  );

  // The config endpoint reports lastRunAt from daemon-process state, which
  // can lag the run history (e.g. right after a restart on older daemons).
  // Fall back to the newest completed run so completed runs never show "—".
  const newestCompletedRun = runs?.find(
    (run) => isExecutedRun(run) && run.status !== "running",
  );
  const lastRunAtDisplay =
    lastRunAt ??
    newestCompletedRun?.finishedAt ??
    newestCompletedRun?.startedAt ??
    null;

  return (
    // Card chrome is the docked pane's, not the full-screen takeover's, so it
    // keys off the same `md:` breakpoint the page docks the pane at.
    <div className="flex h-full flex-col bg-[var(--surface-overlay)] md:rounded-[var(--radius-xl)] md:border md:border-[var(--border-base)]">
      <DetailShellHeader
        title={name}
        closeLabel={t("scheduleDetail.closeAria")}
        closeTooltip={t("scheduleDetail.close")}
        onClose={onClose}
      />

      {/* Scrollable body */}
      <div className="flex-1 space-y-6 overflow-y-auto px-[var(--app-spacing-lg)] py-[var(--app-spacing-lg)]">
        <div>
          <InsetDetailCard title={t("scheduleDetail.details")}>
            <div className="space-y-2 text-body-medium-lighter">
              <InfoRow
                label={t("scheduleDetail.status")}
                value={
                  <>
                    <span className="truncate">{statusValue}</span>
                    {!isMemoryManaged ? (
                      <Toggle
                        size="sm"
                        checked={enabled}
                        onChange={systemTasks.toggleHeartbeat}
                        aria-label={t("scheduleDetail.toggleAria", { name })}
                      />
                    ) : null}
                  </>
                }
              />
              <ModelProfileRow
                assistantId={assistantId}
                defaultCallSite={SYSTEM_TASK_PROFILE_CALL_SITES[kind]}
                fallbackLabel={t("systemTaskDetail.fallbackModelProfile")}
                respectCallSiteOverride
              />
              {/* The task's cadence, e.g. "Every 1 hr". Omitted until the config
                query resolves, rather than rendering a labelled blank. */}
              {subtitle ? (
                <InfoRow
                  label={t("systemTaskDetail.repeats")}
                  value={<span className="truncate">{subtitle}</span>}
                />
              ) : null}
              {!isRetrospective ? (
                <InfoRow
                  label={t("scheduleDetail.nextRun")}
                  value={
                    <span className="truncate">
                      {formatTimestamp(nextRunAt)}
                    </span>
                  }
                />
              ) : null}
              <InfoRow
                label={t("scheduleDetail.lastRun")}
                value={
                  <span className="truncate">
                    {formatTimestamp(lastRunAtDisplay)}
                  </span>
                }
              />
            </div>
          </InsetDetailCard>
          {isMemoryPaused ? (
            <Notice
              tone="warning"
              className="mt-4"
              actions={
                canOpenMemorySettings ? (
                  <Button
                    variant="outlined"
                    size="compact"
                    onClick={() =>
                      navigate(`${routes.settings.developer}?tab=memory`)
                    }
                  >
                    {isRetrospectiveSwitchedOff
                      ? t("systemTaskDetail.openMemorySettings")
                      : t("systemTaskDetail.turnOnMemory")}
                  </Button>
                ) : undefined
              }
            >
              {pausedNotice}
            </Notice>
          ) : null}
        </div>

        <RecentRunsCard
          runs={runs}
          isLoading={isLoading}
          hasMore={hasNextPage}
          isLoadingMore={isFetchingNextPage}
          onLoadMore={() => void fetchNextPage()}
        />
      </div>

      {/* Footer actions */}
      {showMemorySettings || onRunNow ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border-hover)] p-[var(--app-spacing-lg)]">
          {showMemorySettings ? (
            <Button
              variant="outlined"
              leftIcon={<Settings className="h-3.5 w-3.5" />}
              onClick={() =>
                navigate(`${routes.settings.developer}?tab=memory`)
              }
            >
              {t("systemTaskDetail.memorySettings")}
            </Button>
          ) : null}
          {onRunNow ? (
            <Button
              variant="primary"
              leftIcon={
                isRunning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )
              }
              onClick={onRunNow}
              disabled={runNowDisabled}
            >
              {isRunning
                ? t("scheduleDetail.running")
                : t("scheduleDetail.runNow")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
