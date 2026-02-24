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

export interface ReminderFired {
  type: 'reminder_fired';
  reminderId: string;
  label: string;
  message: string;
}

export interface ScheduleComplete {
  type: 'schedule_complete';
  scheduleId: string;
  name: string;
}

export interface WatcherNotification {
  type: 'watcher_notification';
  title: string;
  body: string;
}

export interface WatcherEscalation {
  type: 'watcher_escalation';
  title: string;
  body: string;
}

export interface AgentHeartbeatAlert {
  type: 'agent_heartbeat_alert';
  title: string;
  body: string;
}
