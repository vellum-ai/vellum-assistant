// Schedule, reminder, watcher, and heartbeat types.

// === Client → Server ===

export interface SchedulesList {
  type: 'schedules_list';
}

export interface RemindersList {
  type: 'reminders_list';
}

export interface ReminderCancel {
  type: 'reminder_cancel';
  id: string;
}

export interface ScheduleToggle {
  type: 'schedule_toggle';
  id: string;
  enabled: boolean;
}

export interface ScheduleRemove {
  type: 'schedule_remove';
  id: string;
}

export interface ScheduleRunNow {
  type: 'schedule_run_now';
  id: string;
}

// === Server → Client ===

export interface SchedulesListResponse {
  type: 'schedules_list_response';
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
  }>;
}

export interface RemindersListResponse {
  type: 'reminders_list_response';
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
  type: 'heartbeat_alert';
  title: string;
  body: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _SchedulesClientMessages =
  | SchedulesList
  | ScheduleToggle
  | ScheduleRemove
  | ScheduleRunNow
  | RemindersList
  | ReminderCancel;

export type _SchedulesServerMessages =
  | SchedulesListResponse
  | RemindersListResponse
  | HeartbeatAlert;
