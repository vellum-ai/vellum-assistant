// Schedule, reminder, watcher, and heartbeat types.

// === Client → Server ===

export interface SchedulesList {
  type: "schedules_list";
}

export interface RemindersList {
  type: "reminders_list";
}

export interface ReminderCancel {
  type: "reminder_cancel";
  id: string;
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

// === Server → Client ===

export interface SchedulesListResponse {
  type: "schedules_list_response";
  schedules: Array<{
    id: string;
    name: string;
    enabled: boolean;
    syntax: string;
    expression: string;
    cronExpression: string;
    timezone: string | null;
    message: string;
    nextRunAt: number;
    lastRunAt: number | null;
    lastStatus: string | null;
    description: string;
    mode: string;
    status: string;
    routingIntent: string;
    isOneShot: boolean;
  }>;
}

export interface RemindersListResponse {
  type: "reminders_list_response";
  reminders: Array<{
    id: string;
    label: string;
    message: string;
    fireAt: number;
    mode: string;
    status: string;
    firedAt: number | null;
    createdAt: number;
  }>;
}

export interface HeartbeatAlert {
  type: "heartbeat_alert";
  title: string;
  body: string;
}

export interface HeartbeatConfigResponse {
  type: "heartbeat_config_response";
  enabled: boolean;
  intervalMs: number;
  activeHoursStart: number | null;
  activeHoursEnd: number | null;
  nextRunAt: number | null;
  success: boolean;
  error?: string;
}

export interface HeartbeatRunsListResponse {
  type: "heartbeat_runs_list_response";
  runs: Array<{
    id: string;
    title: string;
    createdAt: number;
    result: string;
    summary?: string;
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

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _SchedulesClientMessages =
  | SchedulesList
  | ScheduleToggle
  | ScheduleRemove
  | ScheduleRunNow
  | RemindersList
  | ReminderCancel
  | HeartbeatConfig
  | HeartbeatRunsList
  | HeartbeatRunNow
  | HeartbeatChecklistRead
  | HeartbeatChecklistWrite;

export type _SchedulesServerMessages =
  | SchedulesListResponse
  | RemindersListResponse
  | HeartbeatAlert
  | HeartbeatConfigResponse
  | HeartbeatRunsListResponse
  | HeartbeatRunNowResponse
  | HeartbeatChecklistResponse
  | HeartbeatChecklistWriteResponse;
