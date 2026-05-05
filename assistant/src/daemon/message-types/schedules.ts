// Schedule, watcher, and heartbeat types.

// === Client → Server ===

export interface SchedulesList {
  type: "schedules_list";
}

export interface ScheduleToggle {
  type: "schedule_toggle";
  id: string;
  enabled: boolean;
}

export interface ScheduleRemove {
  type: "schedule_remove";
  id: string;
}

export interface ScheduleCancel {
  type: "schedule_cancel";
  id: string;
}

export interface ScheduleRunNow {
  type: "schedule_run_now";
  id: string;
}

export interface HeartbeatConfig {
  type: "heartbeat_config";
  action: "get" | "set";
  enabled?: boolean;
  intervalMs?: number;
  activeHoursStart?: number | null;
  activeHoursEnd?: number | null;
}

export interface HeartbeatRunsList {
  type: "heartbeat_runs_list";
  limit?: number;
}

export interface HeartbeatRunNow {
  type: "heartbeat_run_now";
}

export interface HeartbeatChecklistRead {
  type: "heartbeat_checklist_read";
}

export interface HeartbeatChecklistWrite {
  type: "heartbeat_checklist_write";
  content: string;
}

export interface FilingConfig {
  type: "filing_config";
  action: "get";
}

export interface FilingRunNow {
  type: "filing_run_now";
}

// === Server → Client ===

export interface SchedulesListResponse {
  type: "schedules_list_response";
  schedules: Array<{
    id: string;
    name: string;
    enabled: boolean;
    syntax: string;
    expression: string | null;
    cronExpression: string | null;
    timezone: string | null;
    message: string;
    nextRunAt: number;
    lastRunAt: number | null;
    lastStatus: string | null;
    description: string;
    mode: string;
    status: string;
    routingIntent: string;
    reuseConversation: boolean;
    wakeConversationId: string | null;
    isOneShot: boolean;
  }>;
}

export interface HeartbeatAlert {
  type: "heartbeat_alert";
  title: string;
  body: string;
}

/** Server push — broadcast when a heartbeat creates a conversation. */
export interface HeartbeatConversationCreated {
  type: "heartbeat_conversation_created";
  conversationId: string;
  title: string;
}

export interface HeartbeatConfigResponse {
  type: "heartbeat_config_response";
  enabled: boolean;
  intervalMs: number;
  activeHoursStart: number | null;
  activeHoursEnd: number | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  success: boolean;
  error?: string;
}

export interface HeartbeatRunsListResponse {
  type: "heartbeat_runs_list_response";
  runs: Array<{
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
  }>;
}

export interface HeartbeatRunNowResponse {
  type: "heartbeat_run_now_response";
  success: boolean;
  error?: string;
}

export interface HeartbeatChecklistResponse {
  type: "heartbeat_checklist_response";
  content: string;
  isDefault: boolean;
}

export interface HeartbeatChecklistWriteResponse {
  type: "heartbeat_checklist_write_response";
  success: boolean;
  error?: string;
}

export interface FilingConfigResponse {
  type: "filing_config_response";
  enabled: boolean;
  intervalMs: number;
  activeHoursStart: number | null;
  activeHoursEnd: number | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  success: boolean;
  error?: string;
}

export interface FilingRunNowResponse {
  type: "filing_run_now_response";
  success: boolean;
  ran: boolean;
  error?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _SchedulesClientMessages =
  | SchedulesList
  | ScheduleToggle
  | ScheduleRemove
  | ScheduleCancel
  | ScheduleRunNow
  | HeartbeatConfig
  | HeartbeatRunsList
  | HeartbeatRunNow
  | HeartbeatChecklistRead
  | HeartbeatChecklistWrite
  | FilingConfig
  | FilingRunNow;

export type _SchedulesServerMessages =
  | SchedulesListResponse
  | HeartbeatAlert
  | HeartbeatConversationCreated
  | HeartbeatConfigResponse
  | HeartbeatRunsListResponse
  | HeartbeatRunNowResponse
  | HeartbeatChecklistResponse
  | HeartbeatChecklistWriteResponse
  | FilingConfigResponse
  | FilingRunNowResponse;
