import { ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { DetailCard } from "@/components/detail-card";
import { StatusDot } from "@/domains/settings/components/schedule-shared-ui";
import {
  formatDuration,
  formatScheduleCost,
  formatTimestamp,
  getOpenableScheduleRunConversationId,
  hasRunText,
} from "@/domains/settings/utils/schedule-formatters";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { PanelItem } from "@vellumai/design-library/components/panel-item";

import type { ScheduleRun } from "@/domains/settings/types/schedules";

interface RecentRunsCardProps {
  runs: ScheduleRun[] | undefined;
  isLoading: boolean;
  emptyMessage?: string;
  /** Whether older runs exist beyond the loaded pages. */
  hasMore?: boolean;
  /** Whether an older page is currently being fetched. */
  isLoadingMore?: boolean;
  /** Fetch the next (older) page of runs. */
  onLoadMore?: () => void;
}

export function RecentRunsCard({
  runs,
  isLoading,
  emptyMessage = "No runs yet.",
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
}: RecentRunsCardProps) {
  const navigate = useNavigate();
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  return (
    <DetailCard title="Recent runs">
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-stone-400" />
        </div>
      ) : !runs || runs.length === 0 ? (
        <p className="py-4 text-center text-body-medium-lighter text-[var(--content-tertiary)] italic">
          {emptyMessage}
        </p>
      ) : (
        <div className="divide-y divide-[var(--border-base)]">
          {runs.map((run, index) => {
            const conversationId = getOpenableScheduleRunConversationId(run);
            const hasOutput = hasRunText(run.output);
            const hasError = hasRunText(run.error);
            const hasLocalDetails = !conversationId && (hasOutput || hasError);
            const isExpanded = expandedRunId === run.id;
            const detailsId = `schedule-run-details-${index}`;
            return (
              <div key={run.id}>
                <PanelItem
                  label={
                    <span className="flex min-w-0 flex-1 items-center gap-3">
                      <StatusDot status={run.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body-medium-lighter text-[var(--content-default)]">
                          {/* Runs with a title (memory retrospectives) lead
                              with it — it names the reviewed conversation —
                              and keep the timestamp on the detail line. */}
                          {hasRunText(run.title)
                            ? run.title
                            : formatTimestamp(run.startedAt)}
                        </span>
                        <span className="block text-body-small-default text-[var(--content-tertiary)]">
                          {hasRunText(run.title)
                            ? `${formatTimestamp(run.startedAt)} · `
                            : ""}
                          {formatDuration(run.durationMs)} ·{" "}
                          {formatScheduleCost(run.estimatedCostUsd)}
                          {run.status === "error" && run.error && (
                            <span className="ml-2 text-[var(--system-negative-strong)]">
                              {run.error.slice(0, 80)}
                              {run.error.length > 80 ? "…" : ""}
                            </span>
                          )}
                        </span>
                      </span>
                      {conversationId || hasLocalDetails ? (
                        <ChevronRight
                          className={`h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform ${
                            isExpanded ? "rotate-90" : ""
                          }`}
                        />
                      ) : null}
                    </span>
                  }
                  onSelect={
                    conversationId
                      ? () => navigate(routes.conversation(conversationId))
                      : hasLocalDetails
                        ? () =>
                            setExpandedRunId(isExpanded ? null : run.id)
                        : undefined
                  }
                  aria-label={`Run at ${formatTimestamp(run.startedAt)}`}
                  aria-expanded={hasLocalDetails ? isExpanded : undefined}
                  aria-controls={hasLocalDetails ? detailsId : undefined}
                  className="h-auto py-2.5 gap-3 -mx-2 px-2"
                />
                {hasLocalDetails && isExpanded ? (
                  <div id={detailsId} className="px-2 pb-3">
                    <div className="space-y-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
                      {hasOutput ? (
                        <div>
                          <div className="mb-1 text-body-small-default text-[var(--content-secondary)]">
                            Output
                          </div>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-body-small-default font-mono text-[var(--content-default)]">
                            {run.output}
                          </pre>
                        </div>
                      ) : null}
                      {hasError ? (
                        <div>
                          <div className="mb-1 text-body-small-default text-[var(--content-secondary)]">
                            Error
                          </div>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-body-small-default font-mono text-[var(--system-negative-strong)]">
                            {run.error}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
          {hasMore && onLoadMore ? (
            <div className="flex justify-center pt-3">
              <Button
                variant="outlined"
                size="compact"
                onClick={onLoadMore}
                disabled={isLoadingMore}
                leftIcon={
                  isLoadingMore ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : undefined
                }
              >
                {isLoadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </DetailCard>
  );
}
