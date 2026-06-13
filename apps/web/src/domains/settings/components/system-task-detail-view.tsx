import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Play, Settings } from "lucide-react";

import { DetailCard } from "@/components/detail-card";
import {
  fetchConsolidationRuns,
  fetchHeartbeatRuns,
  fetchRetrospectiveRuns,
  SCHEDULE_RUNS_PAGE_SIZE,
} from "@/domains/settings/api/schedules";
import { RecentRunsCard } from "@/domains/settings/components/recent-runs-card";
import {
  flattenRunPages,
  formatTimestamp,
} from "@/domains/settings/utils/schedule-formatters";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag } from "@vellumai/design-library/components/tag";
import { Toggle } from "@vellumai/design-library/components/toggle";

import type { SystemTaskKind } from "@/domains/settings/types/schedules";

interface SystemTaskDetailViewProps {
  kind: SystemTaskKind;
  assistantId: string;
  name: string;
  subtitle: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  isRunning: boolean;
  onBack: () => void;
  /**
   * Triggers an immediate run. Omit for event-driven tasks (memory
   * retrospective) that have nothing global to trigger — the Run now
   * button is hidden when absent.
   */
  onRunNow?: () => void;
  /** Pauses/resumes automatic runs. Manual Run now stays available. */
  onToggleEnabled?: (enabled: boolean) => void;
  onOpenMemorySettings?: () => void;
}

export function SystemTaskDetailView({
  kind,
  assistantId,
  name,
  subtitle,
  enabled,
  nextRunAt,
  lastRunAt,
  isRunning,
  onBack,
  onRunNow,
  onToggleEnabled,
  onOpenMemorySettings,
}: SystemTaskDetailViewProps) {
  // Consolidation and retrospective are both owned by Memory: no toggle of
  // their own, paused when Memory is off. Retrospective additionally has no
  // global schedule (event-driven per conversation), so it hides Next run
  // and is rendered without an onRunNow handler.
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

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["system-task-runs", assistantId, kind],
      queryFn: ({ pageParam }) =>
        kind === "heartbeat"
          ? fetchHeartbeatRuns(assistantId, SCHEDULE_RUNS_PAGE_SIZE, pageParam)
          : kind === "consolidation"
            ? fetchConsolidationRuns(
                assistantId,
                SCHEDULE_RUNS_PAGE_SIZE,
                pageParam,
              )
            : fetchRetrospectiveRuns(
                assistantId,
                SCHEDULE_RUNS_PAGE_SIZE,
                pageParam,
              ),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      staleTime: 10_000,
    });
  const runs = flattenRunPages(data?.pages);

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-body-medium-lighter text-[var(--content-secondary)] hover:text-[var(--content-default)] transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to schedules
      </button>

      <DetailCard
        title={name}
        subtitle={subtitle}
        accessory={
          <div className="flex items-center gap-2">
            <Tag tone="neutral">system</Tag>
            {isMemoryManaged && enabled && onOpenMemorySettings ? (
              <Button
                variant="outlined"
                size="compact"
                leftIcon={<Settings className="h-3.5 w-3.5" />}
                onClick={onOpenMemorySettings}
              >
                Memory settings
              </Button>
            ) : null}
            {onRunNow ? (
              <Button
                variant="outlined"
                size="compact"
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
        }
      >
        <div className="space-y-2 text-body-medium-lighter">
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Status</span>
            <span className="flex items-center gap-2">
              <span>{statusValue}</span>
              {!isMemoryManaged && onToggleEnabled ? (
                <Toggle
                  checked={enabled}
                  onChange={onToggleEnabled}
                  aria-label={`Toggle ${name}`}
                />
              ) : null}
            </span>
          </div>
          {!isRetrospective ? (
            <div className="flex items-center justify-between">
              <span className="text-[var(--content-secondary)]">Next run</span>
              <span>{formatTimestamp(nextRunAt)}</span>
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Last run</span>
            <span>{formatTimestamp(lastRunAt)}</span>
          </div>
        </div>
        {isMemoryPaused ? (
          <Notice
            tone="warning"
            className="mt-4"
            actions={
              onOpenMemorySettings ? (
                <Button
                  variant="outlined"
                  size="compact"
                  onClick={onOpenMemorySettings}
                >
                  Turn on Memory
                </Button>
              ) : undefined
            }
          >
            {pausedNotice}
          </Notice>
        ) : null}
      </DetailCard>

      <RecentRunsCard
        runs={runs}
        isLoading={isLoading}
        hasMore={hasNextPage}
        isLoadingMore={isFetchingNextPage}
        onLoadMore={() => void fetchNextPage()}
      />
    </div>
  );
}
