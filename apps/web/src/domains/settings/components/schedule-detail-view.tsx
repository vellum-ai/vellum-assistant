import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  BarChart3,
  Loader2,
  MessageSquare,
  Play,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { DetailCard } from "@/components/detail-card";
import {
  deleteSchedule,
  fetchScheduleRuns,
  runScheduleNow,
  SCHEDULE_RUNS_PAGE_SIZE,
  updateSchedule,
} from "@/domains/settings/api/schedules";
import { RecentRunsCard } from "@/domains/settings/components/recent-runs-card";
import { StatusDot } from "@/domains/settings/components/schedule-shared-ui";
import {
  DEFAULT_SCRIPT_TIMEOUT_MS,
  flattenRunPages,
  formatTimestamp,
  getOpenableScheduleSourceConversationId,
  MAX_SCRIPT_TIMEOUT_SECONDS,
  MIN_SCRIPT_TIMEOUT_SECONDS,
  MODE_TONE,
} from "@/domains/settings/utils/schedule-formatters";
import { captureError } from "@/lib/sentry/capture-error";
import { assistantScheduleRunsQueryKey } from "@/lib/sync/query-tags";
import { fetchUsageProfileMetadata } from "@/utils/profile-metadata";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";

import type { Schedule } from "@/domains/settings/types/schedules";

function ScriptTimeoutField({
  schedule,
  assistantId,
  onUpdated,
}: {
  schedule: Schedule;
  assistantId: string;
  onUpdated: () => void;
}) {
  const effectiveSeconds = Math.round(
    (schedule.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS) / 1000,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(String(effectiveSeconds));
  const [isSaving, setIsSaving] = useState(false);

  const startEditing = () => {
    setValue(String(effectiveSeconds));
    setIsEditing(true);
  };

  const save = async (timeoutMs: number | null) => {
    setIsSaving(true);
    try {
      await updateSchedule(assistantId, schedule.id, { timeoutMs });
      setIsEditing(false);
      onUpdated();
    } catch (error) {
      captureError(error, { context: "schedule_update_timeout" });
      toast.error("Failed to update timeout.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = () => {
    const seconds = Number(value);
    if (
      !Number.isInteger(seconds) ||
      seconds < MIN_SCRIPT_TIMEOUT_SECONDS ||
      seconds > MAX_SCRIPT_TIMEOUT_SECONDS
    ) {
      toast.error(
        `Timeout must be a whole number between ${MIN_SCRIPT_TIMEOUT_SECONDS} and ${MAX_SCRIPT_TIMEOUT_SECONDS} seconds.`,
      );
      return;
    }
    void save(seconds * 1000);
  };

  if (isEditing) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[var(--content-secondary)]">Timeout</span>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={MIN_SCRIPT_TIMEOUT_SECONDS}
            max={MAX_SCRIPT_TIMEOUT_SECONDS}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-24"
            aria-label="Timeout in seconds"
          />
          <span className="text-[var(--content-tertiary)]">sec</span>
          <Button size="compact" onClick={handleSave} disabled={isSaving}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="outlined"
            size="compact"
            onClick={() => setIsEditing(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[var(--content-secondary)]">Timeout</span>
      <div className="flex items-center gap-2">
        <span>
          {effectiveSeconds}s{schedule.timeoutMs == null ? " (default)" : ""}
        </span>
        <Button variant="outlined" size="compact" onClick={startEditing}>
          Edit
        </Button>
        {schedule.timeoutMs != null && (
          <Button
            variant="outlined"
            size="compact"
            onClick={() => void save(null)}
            disabled={isSaving}
          >
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScheduleDetailView
// ---------------------------------------------------------------------------

export function ScheduleDetailView({
  schedule,
  assistantId,
  onBack,
  onDeleted,
  onUpdated,
}: {
  schedule: Schedule;
  assistantId: string;
  onBack: () => void;
  onDeleted: () => void;
  onUpdated: () => void;
}) {
  const navigate = useNavigate();

  const {
    data,
    isLoading,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: assistantScheduleRunsQueryKey(assistantId, schedule.id),
    queryFn: ({ pageParam }) =>
      fetchScheduleRuns(
        assistantId,
        schedule.id,
        SCHEDULE_RUNS_PAGE_SIZE,
        pageParam,
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 10_000,
  });
  const runs = flattenRunPages(data?.pages);

  const [isRunning, setIsRunning] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleRunNow = async () => {
    setIsRunning(true);
    try {
      await runScheduleNow(assistantId, schedule.id);
      void refetch();
    } catch (error) {
      captureError(error, { context: "schedule_run_now" });
      toast.error("Failed to run schedule.");
    } finally {
      setIsRunning(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteSchedule(assistantId, schedule.id);
      onDeleted();
    } catch (error) {
      captureError(error, { context: "schedule_delete" });
      toast.error("Failed to delete schedule.");
      setIsDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const sourceConversationId =
    getOpenableScheduleSourceConversationId(schedule);

  // Resolve the pinned profile's display name from llm.profiles metadata;
  // fall back to the raw profile key while loading or if the profile was
  // deleted from the config after the schedule pinned it.
  const { data: profileMetadata } = useQuery({
    queryKey: ["usage-profile-metadata", assistantId],
    queryFn: () => fetchUsageProfileMetadata(assistantId),
    enabled: schedule.inferenceProfile != null,
    staleTime: 60_000,
  });
  const profileLabel = schedule.inferenceProfile
    ? (profileMetadata?.[schedule.inferenceProfile]?.displayName ??
      schedule.inferenceProfile)
    : "Default (assistant's main model)";

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
        title={schedule.name}
        subtitle={schedule.description}
        accessory={
          <div className="flex items-center gap-2">
            <Tag tone={MODE_TONE[schedule.mode] ?? "neutral"}>
              {schedule.mode}
            </Tag>
            <Button
              variant="outlined"
              size="compact"
              leftIcon={<BarChart3 className="h-3.5 w-3.5" />}
              onClick={() =>
                navigate(routes.logs.usageForSchedule(schedule.id))
              }
            >
              View usage
            </Button>
            {sourceConversationId ? (
              <Button
                variant="outlined"
                size="compact"
                leftIcon={<MessageSquare className="h-3.5 w-3.5" />}
                onClick={() =>
                  navigate(routes.conversation(sourceConversationId))
                }
              >
                Source
              </Button>
            ) : null}
            {schedule.mode === "script" && (
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
                onClick={handleRunNow}
                disabled={isRunning}
              >
                {isRunning ? "Running…" : "Run now"}
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-2 text-body-medium-lighter">
          {schedule.mode === "script" && schedule.script && (
            <div>
              <span className="text-[var(--content-secondary)] text-body-small-default">
                Command
              </span>
              <pre className="mt-1 rounded-md bg-[var(--surface-sunken)] p-2 text-body-small-default font-mono text-[var(--content-default)] whitespace-pre-wrap break-all">
                {schedule.script}
              </pre>
            </div>
          )}
          {schedule.mode === "script" && (
            <ScriptTimeoutField
              schedule={schedule}
              assistantId={assistantId}
              onUpdated={onUpdated}
            />
          )}
          {schedule.cadenceDescription ? (
            <div className="flex items-center justify-between gap-4">
              <span className="text-[var(--content-secondary)]">Cadence</span>
              <span className="min-w-0 text-right">
                {schedule.cadenceDescription}
              </span>
            </div>
          ) : null}
          {(schedule.mode === "execute" ||
            schedule.inferenceProfile != null) && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-[var(--content-secondary)]">
                Model profile
              </span>
              <span className="min-w-0 text-right">{profileLabel}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Status</span>
            <span>{schedule.enabled ? "Enabled" : "Disabled"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--content-secondary)]">Next run</span>
            <span>{formatTimestamp(schedule.nextRunAt)}</span>
          </div>
          {schedule.lastRunAt && (
            <div className="flex items-center justify-between">
              <span className="text-[var(--content-secondary)]">Last run</span>
              <span className="flex items-center gap-2">
                <StatusDot status={schedule.lastStatus} />
                {formatTimestamp(schedule.lastRunAt)}
              </span>
            </div>
          )}
        </div>
      </DetailCard>

      <RecentRunsCard
        runs={runs}
        isLoading={isLoading}
        hasMore={hasNextPage}
        isLoadingMore={isFetchingNextPage}
        onLoadMore={() => void fetchNextPage()}
      />

      <DetailCard title="Danger zone">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-body-medium-default text-[var(--content-default)]">
              Delete this schedule
            </p>
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              Permanently removes the schedule and all its run history. This
              cannot be undone.
            </p>
          </div>
          {!confirmingDelete ? (
            <Button
              variant="dangerOutline"
              size="compact"
              leftIcon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </Button>
          ) : (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="compact"
                onClick={() => setConfirmingDelete(false)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="compact"
                onClick={() => void handleDelete()}
                disabled={isDeleting}
              >
                {isDeleting ? "Deleting…" : "Yes, delete"}
              </Button>
            </div>
          )}
        </div>
      </DetailCard>
    </div>
  );
}
