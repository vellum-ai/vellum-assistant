import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { formatLocalDate } from '../../schedule/schedule-store.js';
import {
  insertReminder,
  listReminders,
  cancelReminder,
} from './reminder-store.js';

function executeReminder(input: Record<string, unknown>): ToolExecutionResult {
  const action = input.action as string | undefined;
  if (!action) {
    return { content: 'Error: action is required', isError: true };
  }

  switch (action) {
    case 'create':
      return createAction(input);
    case 'list':
      return listAction();
    case 'cancel':
      return cancelAction(input);
    default:
      return {
        content: `Error: Unknown action "${action}". Valid actions: create, list, cancel`,
        isError: true,
      };
  }
}

function createAction(input: Record<string, unknown>): ToolExecutionResult {
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

  const fireAt = new Date(fireAtStr).getTime();
  if (isNaN(fireAt)) {
    return { content: `Error: Invalid timestamp "${fireAtStr}". Use ISO 8601 format (e.g. "2025-03-15T09:00:00Z").`, isError: true };
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

function listAction(): ToolExecutionResult {
  const all = listReminders();
  if (all.length === 0) {
    return { content: 'No reminders found.', isError: false };
  }

  const lines = all.map((r) => {
    const status = r.status === 'fired'
      ? `fired at ${formatLocalDate(r.firedAt!)}`
      : r.status;
    return `  - [${r.id}] "${r.label}" — ${formatLocalDate(r.fireAt)} (${r.mode}, ${status})`;
  });

  return { content: `Reminders:\n${lines.join('\n')}`, isError: false };
}

function cancelAction(input: Record<string, unknown>): ToolExecutionResult {
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

class ReminderTool implements Tool {
  name = 'reminder';
  description = 'Create, list, or cancel one-time reminders. Reminders fire at a specific time and either notify the user or execute a message through the assistant.';
  category = 'reminder';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'list', 'cancel'],
            description: 'Reminder action',
          },
          fire_at: {
            type: 'string',
            description: 'ISO 8601 timestamp for when the reminder should fire (required for create)',
          },
          label: {
            type: 'string',
            description: 'Human-readable label (required for create)',
          },
          message: {
            type: 'string',
            description: 'Content shown in notification (notify) or sent to agent (execute). Required for create.',
          },
          mode: {
            type: 'string',
            enum: ['notify', 'execute'],
            description: 'How the reminder fires. Defaults to notify.',
          },
          reminder_id: {
            type: 'string',
            description: 'Reminder ID (required for cancel)',
          },
        },
        required: ['action'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    return executeReminder(input);
  }
}

export const reminderTool = new ReminderTool();
