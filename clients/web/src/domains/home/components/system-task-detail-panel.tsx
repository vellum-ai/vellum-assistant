import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2, Play, Settings, X } from "lucide-react";
import { useNavigate } from "react-router";

import { SCHEDULE_RUNS_PAGE_SIZE } from "@/domains/settings/api/schedules";
import {
  ModelProfileRow,
  type ScheduleModelProfileCallSite,
} from "@/domains/settings/components/model-profile-row";
import { RecentRunsCard } from "@/domains/settings/components/recent-runs-card";
import {
  consolidationSubtitle,
  flattenRunPages,
  formatTimestamp,
  heartbeatSubtitle,
  RETROSPECTIVE_SUBTITLE,
} from "@/domains/settings/utils/schedule-formatters";
import { toScheduleRun } from "@/domains/settings/utils/system-task-run-transforms";
import {
  consolidationRunsGetInfiniteOptions,
  heartbeatRunsGetInfiniteOptions,
  retrospectiveRunsGetInfiniteOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { routes } from "@/utils/routes";
import { Button, Typography, cn } from "@vellumai/design-library";
import { Notice } from "@vellumai/design-library/components/notice";
import { Toggle } from "@vellumai/design-library/components/toggle";

import type { SystemTaskKind } from "@/domains/settings/types/schedules";

// Each system task resolves its model from a dedicated LLM call site.
const SYSTEM_TASK_PROFILE_CALL_SITES: Record<
  SystemTaskKind,
  ScheduleModelProfileCallSite
> = {
  heartbeat: "heartbeatAgent",
  consolidation: "memoryV2Consolidation",
  retrospective: "memoryRetrospective",
};

type SystemTasksData = ReturnType<
  typeof import("@/domains/settings/hooks/use-system-tasks").useSystemTasks
>;

function SectionLabel({ children }: { children: string }) {
  return (
    <Typography
      variant="label-small-default"
      as="div"
      className="mb-2 uppercase tracking-wider text-[var(--content-tertiary)]"
    >
      {children}
    </Typography>
  );
}

export interface SystemTaskDetailPanelProps {
  kind: SystemTaskKind;
  assistantId: string;
  systemTasks: SystemTasksData;
  canOpenMemorySettings: boolean;
  isMobile?: boolean;
  onClose: () => void;
}

/**
 * Inline detail for a built-in system task (heartbeat, consolidation, memory
 * retrospective) shown in the home right pane. Mirrors `ScheduleDetailPanel`'s
 * chrome so system and user schedules share one side-panel UX, while reusing
 * the system-task config/runs/mutations from `useSystemTasks`.
 */
export function SystemTaskDetailPanel({
  kind,
  assistantId,
  systemTasks,
  canOpenMemorySettings,
  isMobile,
  onClose,
}: SystemTaskDetailPanelProps) {
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
    name = "Heartbeat";
    subtitle = heartbeatConfig ? heartbeatSubtitle(heartbeatConfig) : "";
    enabled = heartbeatConfig?.enabled ?? false;
    nextRunAt = heartbeatConfig?.nextRunAt ?? null;
    lastRunAt = heartbeatConfig?.lastRunAt ?? null;
    isRunning = systemTasks.isHeartbeatRunning;
    onRunNow = systemTasks.runHeartbeatNow;
  } else if (kind === "consolidation") {
    name = "Consolidation";
    subtitle = consolidationConfig
      ? consolidationSubtitle(consolidationConfig)
      : "";
    enabled = consolidationConfig?.enabled ?? false;
    nextRunAt = consolidationConfig?.nextRunAt ?? null;
    lastRunAt = consolidationConfig?.lastRunAt ?? null;
    isRunning = systemTasks.isConsolidationRunning;
    onRunNow = systemTasks.runConsolidationNow;
  } else {
    name = "Memory retrospective";
    subtitle = RETROSPECTIVE_SUBTITLE;
    enabled = retrospectiveConfig?.enabled ?? false;
    // Event-driven: no global "next run".
    nextRunAt = retrospectiveConfig?.nextRunAt ?? null;
    lastRunAt = retrospectiveConfig?.lastRunAt ?? null;
    isRunning = false;
    onRunNow = undefined;
  }

  // Consolidation and retrospective are owned by Memory: no toggle of their
  // own, paused when Memory is off. Retrospective additionally has no global
  // schedule, so it hides Next run.
  const isMemoryManaged = kind !== "heartbeat";
  const isRetrospective = kind === "retrospective";
  const isMemoryPaused = isMemoryManaged && !enabled;
  const runNowDisabled = isRunning || isMemoryPaused;
  const statusValue = isMemoryManaged
    ? enabled
      ? "On · Managed by Memory"
      : "Paused"
    : enabled
      ? "Enabled"
      : "Disabled";
  const pausedNotice = isRetrospective
    ? "Memory is off, so retrospectives are paused. Turn Memory back on to resume them."
    : "Memory is off, so consolidation is paused. Turn Memory back on to resume consolidation.";
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
      runs: page.runs.map((run) => toScheduleRun(run, kind)),
    })),
  );

  return (
    <div
      className={cn(
        "flex h-full flex-col bg-[var(--surface-overlay)]",
        !isMobile &&
          "rounded-[var(--radius-xl)] border border-[var(--border-base)]",
      )}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-base)] p-[var(--app-spacing-lg)]">
        <div className="min-w-0 flex-1">
          <Typography
            variant="title-small"
            className="truncate text-[var(--content-default)]"
          >
            {name}
          </Typography>
          {subtitle ? (
            <Typography
              variant="body-small-default"
              as="p"
              className="truncate text-[var(--content-tertiary)]"
            >
              {subtitle}
            </Typography>
          ) : null}
        </div>
        <Button
          variant="ghost"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close schedule details"
          tooltip="Close"
          className="shrink-0"
        />
      </div>

      {/* Scrollable body */}
      <div className="flex-1 space-y-6 overflow-y-auto px-[var(--app-spacing-lg)] py-[var(--app-spacing-lg)]">
        <section>
          <SectionLabel>Details</SectionLabel>
          <div className="space-y-2 rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] px-4 py-3 text-body-medium-lighter">
            <ModelProfileRow
              assistantId={assistantId}
              defaultCallSite={SYSTEM_TASK_PROFILE_CALL_SITES[kind]}
              fallbackLabel="Default (system task model)"
              respectCallSiteOverride
            />
            <div className="flex items-center justify-between gap-4">
              <span className="text-[var(--content-secondary)]">Status</span>
              <span className="flex items-center gap-2 text-[var(--content-default)]">
                <span>{statusValue}</span>
                {!isMemoryManaged ? (
                  <Toggle
                    checked={enabled}
                    onChange={systemTasks.toggleHeartbeat}
                    aria-label={`Toggle ${name}`}
                  />
                ) : null}
              </span>
            </div>
            {!isRetrospective ? (
              <div className="flex items-center justify-between gap-4">
                <span className="text-[var(--content-secondary)]">
                  Next run
                </span>
                <span className="text-[var(--content-default)]">
                  {formatTimestamp(nextRunAt)}
                </span>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-4">
              <span className="text-[var(--content-secondary)]">Last run</span>
              <span className="text-[var(--content-default)]">
                {formatTimestamp(lastRunAt)}
              </span>
            </div>
          </div>
          {isMemoryPaused ? (
            <Notice
              tone="warning"
              className="mt-4"
              actions={
                canOpenMemorySettings ? (
                  <Button
                    variant="outlined"
                    size="compact"
                    onClick={() => navigate(`${routes.settings.developer}?tab=memory`)}
                  >
                    Turn on Memory
                  </Button>
                ) : undefined
              }
            >
              {pausedNotice}
            </Notice>
          ) : null}
        </section>

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
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border-base)] p-[var(--app-spacing-lg)]">
          {showMemorySettings ? (
            <Button
              variant="outlined"
              leftIcon={<Settings className="h-3.5 w-3.5" />}
              onClick={() => navigate(`${routes.settings.developer}?tab=memory`)}
            >
              Memory settings
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
              {isRunning ? "Running…" : "Run now"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
