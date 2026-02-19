import type { ToolExecutionResult } from '../types.js';
import { formatLocalDate } from '../../schedule/schedule-store.js';
import {
  insertReminder,
  listReminders,
  cancelReminder,
} from './reminder-store.js';

// ── Exported execute functions ──────────────────────────────────────

export function executeReminderCreate(input: Record<string, unknown>): ToolExecutionResult {
  const fireAtStr = input.fire_at as string | undefined;
  const label = input.label as string | undefined;
  const message = input.message as string | undefined;
  const mode = (input.mode as string | undefined) ?? 'notify';

  if (!fireAtStr) {
    return { content: 'Error: fire_at is required for create', isError: true };
  }
  if (!label) {
    return { content: 'Error: label is required for create', isError: true };
  }
  if (!message) {
    return { content: 'Error: message is required for create', isError: true };
  }
  if (mode !== 'notify' && mode !== 'execute') {
    return { content: 'Error: mode must be "notify" or "execute"', isError: true };
  }

  // Require strict ISO 8601 with timezone offset or Z to avoid ambiguous parsing
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(fireAtStr)) {
    return { content: `Error: Invalid timestamp "${fireAtStr}". Use ISO 8601 format with timezone (e.g. "2025-03-15T09:00:00Z" or "2025-03-15T09:00:00-05:00").`, isError: true };
  }
  const fireAt = new Date(fireAtStr).getTime();
  if (isNaN(fireAt)) {
    return { content: `Error: Invalid timestamp "${fireAtStr}". Use ISO 8601 format with timezone (e.g. "2025-03-15T09:00:00Z").`, isError: true };
  }
  if (fireAt <= Date.now()) {
    return { content: 'Error: fire_at must be in the future', isError: true };
  }

  const reminder = insertReminder({ label, message, fireAt, mode });

  return {
    content: `Reminder created.\n  ID: ${reminder.id}\n  Label: ${reminder.label}\n  Fires at: ${formatLocalDate(reminder.fireAt)}\n  Mode: ${reminder.mode}`,
    isError: false,
  };
}

export function executeReminderList(): ToolExecutionResult {
  const all = listReminders();
  if (all.length === 0) {
    return { content: 'No reminders found.', isError: false };
  }

  const lines = all.map((r) => {
    const status = r.status === 'fired'
      ? `fired at ${formatLocalDate(r.firedAt!)}`
      : r.status === 'firing'
        ? 'firing'
        : r.status;
    return `  - [${r.id}] "${r.label}" — ${formatLocalDate(r.fireAt)} (${r.mode}, ${status})`;
  });

  return { content: `Reminders:\n${lines.join('\n')}`, isError: false };
}

export function executeReminderCancel(input: Record<string, unknown>): ToolExecutionResult {
  const reminderId = input.reminder_id as string | undefined;
  if (!reminderId) {
    return { content: 'Error: reminder_id is required for cancel', isError: true };
  }

  const ok = cancelReminder(reminderId);
  if (!ok) {
    return { content: `Error: Reminder "${reminderId}" not found or already fired/cancelled.`, isError: true };
  }

  return { content: `Reminder "${reminderId}" cancelled.`, isError: false };
}
