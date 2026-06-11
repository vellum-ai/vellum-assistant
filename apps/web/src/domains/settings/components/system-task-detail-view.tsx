import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Play, Settings } from "lucide-react";

import { DetailCard } from "@/components/detail-card";
import {
  fetchConsolidationRuns,
  fetchHeartbeatRuns,
} from "@/domains/settings/api/schedules";
import { RecentRunsCard } from "@/domains/settings/components/recent-runs-card";
import { formatTimestamp } from "@/domains/settings/utils/schedule-formatters";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag } from "@vellumai/design-library/components/tag";

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
  onRunNow: () => void;
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
  onOpenMemorySettings,
}: SystemTaskDetailViewProps) {
  const isConsolidationPaused = kind === "consolidation" && !enabled;
  const runNowDisabled = isRunning || isConsolidationPaused;

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
            {kind === "consolidation" && onOpenMemorySettings ? (
              <Button
                variant="outlined"
                size="compact"
                leftIcon={<Settings className="h-3.5 w-3.5" />}
                onClick={onOpenMemorySettings}
              >
                Memory settings
              </Button>
            ) : null}
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
              {isRunning
                ? "Running…"
                : isConsolidationPaused
                  ? "Paused"
                  : "Run now"}
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
        {kind === "consolidation" ? (
          <Notice tone={enabled ? "info" : "warning"} className="mt-4">
            {enabled
              ? "Consolidation is managed by Memory. To turn off consolidation, disable Memory as a whole."
              : "Memory is off, so consolidation is paused. Turn Memory back on to resume consolidation."}
          </Notice>
        ) : null}
      </DetailCard>

      <RecentRunsCard runs={runs} isLoading={isLoading} />
    </div>
  );
}
