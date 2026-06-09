import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Loader2, Play } from "lucide-react";

import { DetailCard } from "@/components/detail-card";
import {
  fetchConsolidationRuns,
  fetchHeartbeatRuns,
} from "@/domains/settings/api/schedules";
import { RecentRunsCard } from "@/domains/settings/components/recent-runs-card";
import {
  consolidationSubtitle,
  formatTimestamp,
  heartbeatSubtitle,
  type ScheduleRowUsage,
} from "@/domains/settings/utils/schedule-formatters";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag } from "@vellumai/design-library/components/tag";
import { Toggle } from "@vellumai/design-library/components/toggle";

import type { SystemTaskKind } from "@/domains/settings/types/schedules";
import type {
  ConsolidationConfigGetResponse,
  HeartbeatConfigGetResponse,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// ScheduleUsageStats (shared between ScheduleRow and SystemTaskRow)
// ---------------------------------------------------------------------------

import { formatScheduleCost, formatScheduleRunCount } from "@/domains/settings/utils/schedule-formatters";

function ScheduleUsageStats({
  scheduleName,
  usage,
  onOpenUsage,
}: {
  scheduleName: string;
  usage: ScheduleRowUsage;
  onOpenUsage?: () => void;
}) {
  if (usage.status === "loading") {
    return (
      <div
        aria-label="Loading schedule usage"
        className="flex w-[136px] shrink-0 items-center justify-end gap-3"
      >
        <span className="h-8 w-14 animate-pulse rounded bg-[var(--surface-muted)]" />
        <span className="h-8 w-14 animate-pulse rounded bg-[var(--surface-muted)]" />
      </div>
    );
  }

  const isUnavailable = usage.status === "error";
  const cost = isUnavailable
    ? "--"
    : formatScheduleCost(usage.summary.totalEstimatedCostUsd);
  const runs = isUnavailable
    ? "--"
    : formatScheduleRunCount(usage.summary.runCount);

  return (
    <div className="flex w-[136px] shrink-0 items-center justify-end gap-3 text-right">
      {onOpenUsage ? (
        <button
          type="button"
          onClick={onOpenUsage}
          aria-label={`View usage for ${scheduleName}`}
          className="min-w-[54px] cursor-pointer rounded px-1 py-0.5 text-right transition-colors hover:bg-[var(--surface-hover)]"
        >
          <span className="block text-label-small-default text-[var(--content-tertiary)]">
            Cost
          </span>
          <span className="block text-body-small-default text-[var(--content-default)]">
            {cost}
          </span>
        </button>
      ) : (
        <span
          aria-label={`Cost for ${scheduleName} in the last 7 days: ${cost}`}
          className="block min-w-[54px] px-1 py-0.5"
        >
          <span className="block text-label-small-default text-[var(--content-tertiary)]">
            Cost
          </span>
          <span className="block text-body-small-default text-[var(--content-default)]">
            {cost}
          </span>
        </span>
      )}
      <span
        aria-label={`Runs for ${scheduleName} in the last 7 days: ${runs}`}
        className="block min-w-[54px] px-1 py-0.5"
      >
        <span className="block text-label-small-default text-[var(--content-tertiary)]">
          Runs
        </span>
        <span className="block text-body-small-default text-[var(--content-default)]">
          {runs}
        </span>
      </span>
    </div>
  );
}

export { ScheduleUsageStats };

// ---------------------------------------------------------------------------
// SystemTaskRow
// ---------------------------------------------------------------------------

interface SystemTaskRowProps {
  name: string;
  subtitle: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  usage: ScheduleRowUsage;
  showToggle: boolean;
  onClick: () => void;
  onToggle: (enabled: boolean) => void;
}

export function SystemTaskRow({
  name,
  subtitle,
  enabled,
  nextRunAt,
  lastRunAt,
  usage,
  showToggle,
  onClick,
  onToggle,
}: SystemTaskRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-[var(--surface-hover)] [&+&]:border-t [&+&]:border-[var(--border-base)]">
      <button
        type="button"
        onClick={onClick}
        aria-label={`Open ${name}`}
        className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-body-medium-default text-[var(--content-default)]">
              {name}
            </span>
            <Tag tone="neutral">system</Tag>
          </div>
          <div className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
            {subtitle}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-body-small-default text-[var(--content-tertiary)]">
            {nextRunAt ? (
              <span>Next: {formatTimestamp(nextRunAt)}</span>
            ) : null}
            {lastRunAt ? (
              <span>Last: {formatTimestamp(lastRunAt)}</span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
          <ScheduleUsageStats scheduleName={name} usage={usage} />
          {showToggle ? null : (
            <span
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: enabled
                  ? "var(--system-positive-strong)"
                  : "var(--content-disabled)",
              }}
              aria-label={enabled ? "enabled" : "disabled"}
            />
          )}
          <ChevronRight className="h-4 w-4 text-[var(--content-tertiary)]" />
        </div>
      </button>
      {showToggle ? (
        <Toggle
          checked={enabled}
          onChange={onToggle}
          aria-label={`Toggle ${name}`}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SystemTasksSection
// ---------------------------------------------------------------------------

interface SystemTasksSectionProps {
  heartbeatConfig: HeartbeatConfigGetResponse | undefined;
  consolidationConfig: ConsolidationConfigGetResponse | undefined;
  heartbeatUsage: ScheduleRowUsage;
  consolidationUsage: ScheduleRowUsage;
  isLoading: boolean;
  hasError: boolean;
  onRetry: () => void;
  onSelectHeartbeat: () => void;
  onSelectConsolidation: () => void;
  showSystemTaskToggles: boolean;
  onToggleHeartbeat: (enabled: boolean) => void;
  onToggleConsolidation: (enabled: boolean) => void;
}

export function SystemTasksSection({
  heartbeatConfig,
  consolidationConfig,
  heartbeatUsage,
  consolidationUsage,
  isLoading,
  hasError,
  onRetry,
  onSelectHeartbeat,
  onSelectConsolidation,
  showSystemTaskToggles,
  onToggleHeartbeat,
  onToggleConsolidation,
}: SystemTasksSectionProps) {
  const showHeartbeat = heartbeatConfig != null;
  const showConsolidation = consolidationConfig?.available === true;

  if (!isLoading && !hasError && !showHeartbeat && !showConsolidation) {
    return null;
  }

  return (
    <DetailCard
      title="System"
      subtitle="Built-in jobs managed by the assistant runtime."
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-stone-400" />
        </div>
      ) : hasError && !showHeartbeat && !showConsolidation ? (
        <Notice tone="error">
          Failed to load system jobs.{" "}
          <button
            type="button"
            onClick={onRetry}
            className="cursor-pointer underline hover:no-underline"
          >
            Retry
          </button>
        </Notice>
      ) : (
        <div>
          {showHeartbeat ? (
            <SystemTaskRow
              name="Heartbeat"
              subtitle={heartbeatSubtitle(heartbeatConfig)}
              enabled={heartbeatConfig.enabled}
              nextRunAt={heartbeatConfig.nextRunAt}
              lastRunAt={heartbeatConfig.lastRunAt}
              usage={heartbeatUsage}
              showToggle={showSystemTaskToggles}
              onClick={onSelectHeartbeat}
              onToggle={onToggleHeartbeat}
            />
          ) : null}
          {showConsolidation ? (
            <SystemTaskRow
              name="Consolidation"
              subtitle={consolidationSubtitle(consolidationConfig)}
              enabled={consolidationConfig.enabled}
              nextRunAt={consolidationConfig.nextRunAt}
              lastRunAt={consolidationConfig.lastRunAt}
              usage={consolidationUsage}
              showToggle={showSystemTaskToggles}
              onClick={onSelectConsolidation}
              onToggle={onToggleConsolidation}
            />
          ) : null}
          {hasError ? (
            <div className="pt-3 first:pt-0">
              <Notice tone="error">
                Some system jobs failed to load.{" "}
                <button
                  type="button"
                  onClick={onRetry}
                  className="cursor-pointer underline hover:no-underline"
                >
                  Retry
                </button>
              </Notice>
            </div>
          ) : null}
        </div>
      )}
    </DetailCard>
  );
}

// ---------------------------------------------------------------------------
// SystemTaskDetailView
// ---------------------------------------------------------------------------

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
  onRunNow: () => void;
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
}: SystemTaskDetailViewProps) {
  const { data: runs, isLoading } = useQuery({
    queryKey: ["system-task-runs", assistantId, kind],
    queryFn: () =>
      kind === "heartbeat"
        ? fetchHeartbeatRuns(assistantId)
        : fetchConsolidationRuns(assistantId),
    staleTime: 10_000,
  });

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
              disabled={isRunning}
            >
              {isRunning ? "Running…" : "Run now"}
            </Button>
          </div>
        }
      >
        <div className="space-y-2 text-body-medium-lighter">
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Status</span>
            <span>{enabled ? "Enabled" : "Disabled"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Next run</span>
            <span>{formatTimestamp(nextRunAt)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Last run</span>
            <span>{formatTimestamp(lastRunAt)}</span>
          </div>
        </div>
      </DetailCard>

      <RecentRunsCard runs={runs} isLoading={isLoading} />
    </div>
  );
}
