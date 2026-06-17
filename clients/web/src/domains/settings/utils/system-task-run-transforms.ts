import type {
  ConsolidationRunsGetResponse,
  HeartbeatRunsGetResponse,
  RetrospectiveRunsGetResponse,
} from "@/generated/daemon/types.gen";

import type {
  ScheduleRun,
  SystemTaskKind,
} from "@/domains/settings/types/schedules";

type HeartbeatRun = HeartbeatRunsGetResponse["runs"][number];
type ConsolidationRun = ConsolidationRunsGetResponse["runs"][number];
type RetrospectiveRun = RetrospectiveRunsGetResponse["runs"][number];

/** Union of all raw system-task run types from the daemon SDK. */
export type AnySystemTaskRun = HeartbeatRun | ConsolidationRun | RetrospectiveRun;

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
    output:
      "skipReason" in run && run.skipReason
        ? `Skipped: ${run.skipReason}`
        : null,
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
  return data.runs.map((r) => toScheduleRun(r, "heartbeat"));
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
