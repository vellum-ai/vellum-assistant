import { ChevronRight, Loader2 } from "lucide-react";

import { DetailCard } from "@/components/detail-card";
import { ScheduleUsageStats } from "@/domains/settings/components/schedule-shared-ui";
import {
  consolidationSubtitle,
  formatTimestamp,
  heartbeatSubtitle,
  type ScheduleRowUsage,
} from "@/domains/settings/utils/schedule-formatters";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag, type TagTone } from "@vellumai/design-library/components/tag";
import { Toggle } from "@vellumai/design-library/components/toggle";

import type {
  ConsolidationConfigGetResponse,
  HeartbeatConfigGetResponse,
} from "@/generated/daemon/types.gen";

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
  helperText?: string;
  statusLabel?: string;
  statusTone?: TagTone;
  onClick: () => void;
  onOpenUsage?: () => void;
  onToggle?: (enabled: boolean) => void;
}

export function SystemTaskRow({
  name,
  subtitle,
  enabled,
  nextRunAt,
  lastRunAt,
  usage,
  showToggle,
  helperText,
  statusLabel,
  statusTone = "neutral",
  onClick,
  onOpenUsage,
  onToggle,
}: SystemTaskRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-[var(--surface-hover)] [&+&]:border-t [&+&]:border-[var(--border-base)]">
      <button
        type="button"
        onClick={onClick}
        aria-label={`Open ${name}`}
        className="min-w-0 flex-1 cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-body-medium-default text-[var(--content-default)]">
            {name}
          </span>
        </div>
        <div className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
          {subtitle}
        </div>
        {helperText ? (
          <div className="mt-0.5 text-body-small-default text-[var(--content-secondary)]">
            {helperText}
          </div>
        ) : null}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-body-small-default text-[var(--content-tertiary)]">
          {nextRunAt ? <span>Next: {formatTimestamp(nextRunAt)}</span> : null}
          {lastRunAt ? <span>Last: {formatTimestamp(lastRunAt)}</span> : null}
        </div>
      </button>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
        <ScheduleUsageStats
          scheduleName={name}
          usage={usage}
          onOpenUsage={onOpenUsage}
        />
        {showToggle ? null : statusLabel ? (
          <Tag tone={statusTone}>{statusLabel}</Tag>
        ) : (
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
        <button
          type="button"
          onClick={onClick}
          aria-label={`Open ${name} details`}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)]"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      {showToggle && onToggle ? (
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
  onOpenHeartbeatUsage: () => void;
  onOpenConsolidationUsage: () => void;
  showSystemTaskToggles: boolean;
  onToggleHeartbeat: (enabled: boolean) => void;
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
  onOpenHeartbeatUsage,
  onOpenConsolidationUsage,
  showSystemTaskToggles,
  onToggleHeartbeat,
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
              onOpenUsage={onOpenHeartbeatUsage}
              onToggle={onToggleHeartbeat}
            />
          ) : null}
          {showConsolidation ? (
            <SystemTaskRow
              name="Consolidation"
              subtitle={consolidationSubtitle(consolidationConfig)}
              enabled={consolidationConfig.enabled}
              helperText={
                consolidationConfig.enabled
                  ? "Consolidation is part of Memory. Disable Memory to stop it."
                  : "Memory is off, so consolidation is paused."
              }
              nextRunAt={consolidationConfig.nextRunAt}
              lastRunAt={consolidationConfig.lastRunAt}
              usage={consolidationUsage}
              showToggle={false}
              statusLabel={
                consolidationConfig.enabled ? "Managed by Memory" : "Paused"
              }
              statusTone={consolidationConfig.enabled ? "neutral" : "warning"}
              onClick={onSelectConsolidation}
              onOpenUsage={onOpenConsolidationUsage}
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
