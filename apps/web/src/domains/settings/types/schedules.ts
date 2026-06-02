import type {
  SchedulesByIdRunsGetResponse,
  SchedulesGetResponse,
} from "@/generated/daemon/types.gen";

export type Schedule = SchedulesGetResponse["schedules"][number];

export type ScheduleRun = SchedulesByIdRunsGetResponse["runs"][number];

export type SystemTaskKind = "heartbeat" | "consolidation";

export interface HeartbeatRun {
  id: string;
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  status: string;
  skipReason: string | null;
  error: string | null;
  conversationId: string | null;
  createdAt: number;
}

export interface HeartbeatRunsResponse {
  runs: HeartbeatRun[];
}

export interface HeartbeatConfigResponse {
  enabled: boolean;
  intervalMs: number;
  activeHoursStart: number | null;
  activeHoursEnd: number | null;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  success: boolean;
}

export interface ConsolidationConfigResponse {
  available: boolean;
  enabled: boolean;
  intervalMs: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  success: boolean;
}

export interface RunNowResponse {
  success: boolean;
  ran: boolean;
  jobId?: string | null;
  error?: string;
}
