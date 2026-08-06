import type {
  ConsolidationRunsGetResponse,
  HeartbeatRunsGetResponse,
  RetrospectiveRunsGetResponse,
} from "@/generated/daemon/types.gen";

import { isBookkeepingRun } from "@/domains/settings/utils/schedule-formatters";

import type {
  ScheduleRun,
  SystemTaskKind,
} from "@/domains/settings/types/schedules";

type HeartbeatRun = HeartbeatRunsGetResponse["runs"][number];
type ConsolidationRun = ConsolidationRunsGetResponse["runs"][number];
type RetrospectiveRun = RetrospectiveRunsGetResponse["runs"][number];

/** Union of all raw system-task run types from the daemon SDK. */
export type AnySystemTaskRun =
  HeartbeatRun | ConsolidationRun | RetrospectiveRun;

/** Human-readable labels for heartbeat `skip_reason` codes. */
const SKIP_REASON_LABELS: Record<string, string> = {
  disabled: "heartbeat is disabled",
  outside_active_hours: "outside active hours",
  overlap: "previous run was still active",
  pre_first_user_message: "waiting for the first conversation",
  max_consecutive_runs: "consecutive-run cap reached",
  max_daily_runs: "daily run cap reached",
  quiesced: "assistant was shutting down",
};

/**
 * Detail text for runs that never executed: skipped runs surface why the
 * guard skipped them, missed runs explain the gap. Executed runs return null
 * — their detail line is duration and cost.
 */
function unexecutedRunText(run: AnySystemTaskRun): string | null {
  if (run.status === "missed") {
    return "Missed while the assistant was offline";
  }
  if ("skipReason" in run && run.skipReason) {
    return `Skipped — ${SKIP_REASON_LABELS[run.skipReason] ?? run.skipReason}`;
  }
  return null;
}

/**
 * Maps a raw system-task run from the daemon SDK into the shared
 * {@link ScheduleRun} shape consumed by the schedule UI.
 *
 * `startedAt` is nullable in the SDK type (a run may be scheduled but not
 * yet started); the schedule UI requires a non-null timestamp, so we fall
 * back to `scheduledFor`.
 */
export function toScheduleRun(
  run: HeartbeatRun,
  kind: "heartbeat",
): ScheduleRun;
export function toScheduleRun(
  run: ConsolidationRun,
  kind: "consolidation",
): ScheduleRun;
export function toScheduleRun(
  run: RetrospectiveRun,
  kind: "retrospective",
): ScheduleRun;
export function toScheduleRun(
  run: AnySystemTaskRun,
  kind: SystemTaskKind,
): ScheduleRun;
export function toScheduleRun(
  run: AnySystemTaskRun,
  kind: SystemTaskKind,
): ScheduleRun {
  return {
    id: run.id,
    jobId: kind,
    status: run.status,
    startedAt: run.startedAt ?? run.scheduledFor,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    output: unexecutedRunText(run),
    error: run.error,
    conversationId: run.conversationId,
    conversationExists: run.conversationExists,
    conversationArchivedAt: run.conversationArchivedAt,
    estimatedCostUsd: run.estimatedCostUsd,
    createdAt: run.createdAt,
    ...("title" in run ? { title: run.title } : {}),
  };
}

/** Select transform: extracts `ScheduleRun[]` from a heartbeat runs response. */
export function selectHeartbeatRuns(
  data: HeartbeatRunsGetResponse,
): ScheduleRun[] {
  return data.runs
    .filter((r) => !isBookkeepingRun(r))
    .map((r) => toScheduleRun(r, "heartbeat"));
}

/** Select transform: extracts `ScheduleRun[]` from a consolidation runs response. */
export function selectConsolidationRuns(
  data: ConsolidationRunsGetResponse,
): ScheduleRun[] {
  return data.runs.map((r) => toScheduleRun(r, "consolidation"));
}

/** Select transform: extracts `ScheduleRun[]` from a retrospective runs response. */
export function selectRetrospectiveRuns(
  data: RetrospectiveRunsGetResponse,
): ScheduleRun[] {
  return data.runs.map((r) => toScheduleRun(r, "retrospective"));
}
