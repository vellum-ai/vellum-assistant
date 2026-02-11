import crypto from 'node:crypto';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('pomodoro');

export interface PomodoroTimer {
  id: string;
  label: string;
  durationMinutes: number;
  startedAt: number;
  remainingMs: number;
  status: 'running' | 'paused' | 'completed' | 'cancelled';
  completedAt?: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

/** Module-level map of active timers keyed by timer ID. */
export const timers = new Map<string, PomodoroTimer>();

function generateTimerId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatTimerStatus(timer: PomodoroTimer): string {
  const totalMs = timer.durationMinutes * 60 * 1000;
  let elapsedMs: number;
  let remainingMs: number;

  if (timer.status === 'completed') {
    elapsedMs = totalMs;
    remainingMs = 0;
  } else if (timer.status === 'paused') {
    elapsedMs = totalMs - timer.remainingMs;
    remainingMs = timer.remainingMs;
  } else if (timer.status === 'cancelled') {
    elapsedMs = totalMs - timer.remainingMs;
    remainingMs = timer.remainingMs;
  } else {
    // running
    const now = Date.now();
    elapsedMs = now - timer.startedAt;
    remainingMs = Math.max(0, totalMs - elapsedMs);
    // Correct for resumed timers: remainingMs was set at resume time
    // and startedAt was adjusted, so elapsed = now - startedAt
    // This is correct because startedAt is adjusted on resume.
  }

  const percentage = totalMs > 0 ? Math.min(100, Math.round((elapsedMs / totalMs) * 100)) : 100;

  const lines: string[] = [
    `Timer "${timer.label}" (${timer.id})`,
    `Status: ${timer.status.charAt(0).toUpperCase() + timer.status.slice(1)}`,
    `Duration: ${timer.durationMinutes} minutes`,
    `Elapsed: ${formatDuration(elapsedMs)}`,
    `Remaining: ${formatDuration(remainingMs)}`,
    `Progress: ${percentage}%`,
  ];

  if (timer.completedAt) {
    lines.push(`Completed at: ${new Date(timer.completedAt).toISOString()}`);
  }

  return lines.join('\n');
}

function startAction(input: Record<string, unknown>): ToolExecutionResult {
  const durationMinutes = typeof input.duration_minutes === 'number' && input.duration_minutes > 0
    ? input.duration_minutes
    : 25;
  const label = typeof input.label === 'string' && input.label.length > 0
    ? input.label
    : 'Pomodoro';
  const id = generateTimerId();
  const now = Date.now();
  const durationMs = durationMinutes * 60 * 1000;

  const timer: PomodoroTimer = {
    id,
    label,
    durationMinutes,
    startedAt: now,
    remainingMs: durationMs,
    status: 'running',
  };

  timer.timeoutHandle = setTimeout(() => {
    timer.status = 'completed';
    timer.completedAt = Date.now();
    timer.remainingMs = 0;
    timer.timeoutHandle = undefined;
    log.info({ id: timer.id, label: timer.label }, 'Pomodoro timer completed');
  }, durationMs);

  timers.set(id, timer);
  log.info({ id, label, durationMinutes }, 'Pomodoro timer started');

  const endTime = new Date(now + durationMs).toISOString();
  const content = [
    `Timer "${label}" (${id}) started.`,
    `Duration: ${durationMinutes} minutes`,
    `Started at: ${new Date(now).toISOString()}`,
    `Expected end: ${endTime}`,
  ].join('\n');

  return { content, isError: false };
}

function pauseAction(input: Record<string, unknown>): ToolExecutionResult {
  const timerId = input.timer_id;
  if (typeof timerId !== 'string' || timerId.length === 0) {
    return { content: 'Error: timer_id is required for pause action', isError: true };
  }

  const timer = timers.get(timerId);
  if (!timer) {
    return { content: `Error: Timer "${timerId}" not found`, isError: true };
  }

  if (timer.status !== 'running') {
    return { content: `Error: Timer "${timerId}" is not running (status: ${timer.status})`, isError: true };
  }

  const now = Date.now();
  const elapsed = now - timer.startedAt;
  const totalMs = timer.durationMinutes * 60 * 1000;
  timer.remainingMs = Math.max(0, totalMs - elapsed);
  timer.status = 'paused';

  if (timer.timeoutHandle) {
    clearTimeout(timer.timeoutHandle);
    timer.timeoutHandle = undefined;
  }

  log.info({ id: timerId, remainingMs: timer.remainingMs }, 'Pomodoro timer paused');

  return {
    content: `Timer "${timer.label}" (${timerId}) paused.\nRemaining: ${formatDuration(timer.remainingMs)}`,
    isError: false,
  };
}

function resumeAction(input: Record<string, unknown>): ToolExecutionResult {
  const timerId = input.timer_id;
  if (typeof timerId !== 'string' || timerId.length === 0) {
    return { content: 'Error: timer_id is required for resume action', isError: true };
  }

  const timer = timers.get(timerId);
  if (!timer) {
    return { content: `Error: Timer "${timerId}" not found`, isError: true };
  }

  if (timer.status !== 'paused') {
    return { content: `Error: Timer "${timerId}" is not paused (status: ${timer.status})`, isError: true };
  }

  const now = Date.now();
  // Adjust startedAt so that elapsed calculations remain correct.
  const totalMs = timer.durationMinutes * 60 * 1000;
  timer.startedAt = now - (totalMs - timer.remainingMs);
  timer.status = 'running';

  timer.timeoutHandle = setTimeout(() => {
    timer.status = 'completed';
    timer.completedAt = Date.now();
    timer.remainingMs = 0;
    timer.timeoutHandle = undefined;
    log.info({ id: timer.id, label: timer.label }, 'Pomodoro timer completed');
  }, timer.remainingMs);

  log.info({ id: timerId, remainingMs: timer.remainingMs }, 'Pomodoro timer resumed');

  return {
    content: `Timer "${timer.label}" (${timerId}) resumed.\nRemaining: ${formatDuration(timer.remainingMs)}`,
    isError: false,
  };
}

function cancelAction(input: Record<string, unknown>): ToolExecutionResult {
  const timerId = input.timer_id;
  if (typeof timerId !== 'string' || timerId.length === 0) {
    return { content: 'Error: timer_id is required for cancel action', isError: true };
  }

  const timer = timers.get(timerId);
  if (!timer) {
    return { content: `Error: Timer "${timerId}" not found`, isError: true };
  }

  if (timer.status === 'completed' || timer.status === 'cancelled') {
    return { content: `Error: Timer "${timerId}" is already ${timer.status}`, isError: true };
  }

  if (timer.timeoutHandle) {
    clearTimeout(timer.timeoutHandle);
    timer.timeoutHandle = undefined;
  }

  // Preserve remaining time at time of cancellation
  if (timer.status === 'running') {
    const now = Date.now();
    const elapsed = now - timer.startedAt;
    const totalMs = timer.durationMinutes * 60 * 1000;
    timer.remainingMs = Math.max(0, totalMs - elapsed);
  }

  timer.status = 'cancelled';
  log.info({ id: timerId }, 'Pomodoro timer cancelled');

  return {
    content: `Timer "${timer.label}" (${timerId}) cancelled.`,
    isError: false,
  };
}

function statusAction(input: Record<string, unknown>): ToolExecutionResult {
  const timerId = input.timer_id;
  if (typeof timerId !== 'string' || timerId.length === 0) {
    return { content: 'Error: timer_id is required for status action', isError: true };
  }

  const timer = timers.get(timerId);
  if (!timer) {
    return { content: `Error: Timer "${timerId}" not found`, isError: true };
  }

  return { content: formatTimerStatus(timer), isError: false };
}

function listAction(): ToolExecutionResult {
  if (timers.size === 0) {
    return { content: 'No timers found.', isError: false };
  }

  const entries: string[] = [];
  for (const timer of timers.values()) {
    entries.push(formatTimerStatus(timer));
  }

  return { content: entries.join('\n\n'), isError: false };
}

export function executePomodoro(input: Record<string, unknown>): ToolExecutionResult {
  const action = input.action;
  if (typeof action !== 'string') {
    return { content: 'Error: action is required', isError: true };
  }

  switch (action) {
    case 'start':
      return startAction(input);
    case 'pause':
      return pauseAction(input);
    case 'resume':
      return resumeAction(input);
    case 'cancel':
      return cancelAction(input);
    case 'status':
      return statusAction(input);
    case 'list':
      return listAction();
    default:
      return {
        content: `Error: Unknown action "${action}". Valid actions: start, pause, resume, cancel, status, list`,
        isError: true,
      };
  }
}

class PomodoroTool implements Tool {
  name = 'pomodoro';
  description = 'Manage focus timers. Start, pause, resume, cancel, or check status of pomodoro timers.';
  category = 'timer';
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
            enum: ['start', 'pause', 'resume', 'cancel', 'status', 'list'],
            description: 'Timer action',
          },
          timer_id: {
            type: 'string',
            description: 'Timer ID (required for pause/resume/cancel/status, auto-generated for start)',
          },
          duration_minutes: {
            type: 'number',
            description: 'Duration in minutes (required for start, default 25)',
          },
          label: {
            type: 'string',
            description: 'Optional label for the timer',
          },
        },
        required: ['action'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    return executePomodoro(input);
  }
}

registerTool(new PomodoroTool());
