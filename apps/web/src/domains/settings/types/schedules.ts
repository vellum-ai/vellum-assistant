export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  syntax: "cron" | "rrule";
  expression: string | null;
  cronExpression: string | null;
  timezone: string | null;
  message: string;
  script: string | null;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  description: string;
  mode: "execute" | "notify" | "script";
  status: "active" | "firing" | "fired" | "cancelled";
  routingIntent: string;
  reuseConversation: boolean;
  isOneShot: boolean;
}

export interface SchedulesListResponse {
  schedules: Schedule[];
}

export interface ScheduleRun {
  id: string;
  jobId: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  output: string | null;
  error: string | null;
  conversationId: string | null;
  createdAt: number;
}

export interface ScheduleRunsResponse {
  runs: ScheduleRun[];
}

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
