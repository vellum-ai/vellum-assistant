import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { Cron } from 'croner';
import { getDb } from '../memory/db.js';
import { cronJobs, cronRuns } from '../memory/schema.js';

export interface ScheduleJob {
  id: string;
  name: string;
  enabled: boolean;
  cronExpression: string;
  timezone: string | null;
  message: string;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  retryCount: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
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

export function isValidCronExpression(expr: string): boolean {
  try {
    new Cron(expr, { maxRuns: 0 });
    return true;
  } catch {
    return false;
  }
}

export function computeNextRunAt(cronExpression: string, timezone?: string | null): number {
  const cron = new Cron(cronExpression, {
    timezone: timezone ?? undefined,
  });
  const next = cron.nextRun();
  if (!next) {
    throw new Error(`Cron expression "${cronExpression}" has no upcoming runs`);
  }
  return next.getTime();
}

export function createSchedule(params: {
  name: string;
  cronExpression: string;
  timezone?: string | null;
  message: string;
  enabled?: boolean;
  createdBy?: string;
}): ScheduleJob {
  if (!isValidCronExpression(params.cronExpression)) {
    throw new Error(`Invalid cron expression: "${params.cronExpression}"`);
  }

  const db = getDb();
  const id = uuid();
  const now = Date.now();
  const enabled = params.enabled ?? true;
  const timezone = params.timezone ?? null;
  const nextRunAt = enabled ? computeNextRunAt(params.cronExpression, timezone) : 0;

  const row = {
    id,
    name: params.name,
    enabled,
    cronExpression: params.cronExpression,
    timezone,
    message: params.message,
    nextRunAt,
    lastRunAt: null as number | null,
    lastStatus: null as string | null,
    retryCount: 0,
    createdBy: params.createdBy ?? 'agent',
    createdAt: now,
    updatedAt: now,
  };

  db.insert(cronJobs).values(row).run();
  return row;
}

export function getSchedule(id: string): ScheduleJob | null {
  const db = getDb();
  const row = db
    .select()
    .from(cronJobs)
    .where(eq(cronJobs.id, id))
    .get();
  if (!row) return null;
  return parseJobRow(row);
}

export function listSchedules(options?: { enabledOnly?: boolean }): ScheduleJob[] {
  const db = getDb();
  const conditions = options?.enabledOnly ? eq(cronJobs.enabled, true) : undefined;
  const rows = db
    .select()
    .from(cronJobs)
    .where(conditions)
    .orderBy(asc(cronJobs.nextRunAt))
    .all();
  return rows.map(parseJobRow);
}

export function updateSchedule(
  id: string,
  updates: {
    name?: string;
    cronExpression?: string;
    timezone?: string | null;
    message?: string;
    enabled?: boolean;
  },
): ScheduleJob | null {
  const db = getDb();
  const existing = db.select().from(cronJobs).where(eq(cronJobs.id, id)).get();
  if (!existing) return null;

  if (updates.cronExpression && !isValidCronExpression(updates.cronExpression)) {
    throw new Error(`Invalid cron expression: "${updates.cronExpression}"`);
  }

  const now = Date.now();
  const set: Record<string, unknown> = { updatedAt: now };

  if (updates.name !== undefined) set.name = updates.name;
  if (updates.cronExpression !== undefined) set.cronExpression = updates.cronExpression;
  if (updates.timezone !== undefined) set.timezone = updates.timezone;
  if (updates.message !== undefined) set.message = updates.message;
  if (updates.enabled !== undefined) set.enabled = updates.enabled;

  // Recompute nextRunAt if expression, timezone, or enabled changed
  const newExpr = updates.cronExpression ?? existing.cronExpression;
  const newTimezone = updates.timezone !== undefined ? updates.timezone : existing.timezone;
  const newEnabled = updates.enabled !== undefined ? updates.enabled : existing.enabled;

  if (
    updates.cronExpression !== undefined ||
    updates.timezone !== undefined ||
    updates.enabled !== undefined
  ) {
    set.nextRunAt = newEnabled ? computeNextRunAt(newExpr, newTimezone) : 0;
  }

  db.update(cronJobs).set(set).where(eq(cronJobs.id, id)).run();

  return getSchedule(id);
}

export function deleteSchedule(id: string): boolean {
  const db = getDb();
  const result = db.delete(cronJobs).where(eq(cronJobs.id, id)).run() as unknown as { changes?: number };
  return (result.changes ?? 0) > 0;
}

/**
 * Claim due schedules atomically. For each candidate where enabled=true and
 * next_run_at <= now, we advance next_run_at using optimistic locking on the
 * old value to prevent double-claiming by concurrent ticks.
 */
export function claimDueSchedules(now: number): ScheduleJob[] {
  const db = getDb();
  const candidates = db
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.enabled, true), lte(cronJobs.nextRunAt, now)))
    .orderBy(asc(cronJobs.nextRunAt))
    .all();

  const claimed: ScheduleJob[] = [];
  for (const row of candidates) {
    let newNextRunAt: number;
    try {
      newNextRunAt = computeNextRunAt(row.cronExpression, row.timezone);
    } catch {
      // Expression has no future runs — skip
      continue;
    }

    // Optimistic lock: only update if nextRunAt hasn't changed
    const result = db
      .update(cronJobs)
      .set({
        nextRunAt: newNextRunAt,
        lastRunAt: now,
        updatedAt: now,
      })
      .where(and(eq(cronJobs.id, row.id), eq(cronJobs.nextRunAt, row.nextRunAt)))
      .run() as unknown as { changes?: number };

    if ((result.changes ?? 0) === 0) continue;

    claimed.push(parseJobRow({
      ...row,
      nextRunAt: newNextRunAt,
      lastRunAt: now,
      updatedAt: now,
    }));
  }
  return claimed;
}

export function createScheduleRun(jobId: string, conversationId: string): string {
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  db.insert(cronRuns).values({
    id,
    jobId,
    status: 'running',
    startedAt: now,
    finishedAt: null,
    durationMs: null,
    output: null,
    error: null,
    conversationId,
    createdAt: now,
  }).run();
  return id;
}

export function completeScheduleRun(
  runId: string,
  result: { status: 'ok' | 'error'; output?: string; error?: string },
): void {
  const db = getDb();
  const now = Date.now();

  // Get the run to compute duration and get jobId
  const run = db.select().from(cronRuns).where(eq(cronRuns.id, runId)).get();
  if (!run) return;

  const durationMs = now - run.startedAt;

  db.update(cronRuns)
    .set({
      status: result.status,
      finishedAt: now,
      durationMs,
      output: result.output?.slice(0, 10_000) ?? null,
      error: result.error?.slice(0, 2000) ?? null,
    })
    .where(eq(cronRuns.id, runId))
    .run();

  // Update the parent job's lastStatus and retryCount
  if (result.status === 'error') {
    // Increment retry count
    const job = db.select().from(cronJobs).where(eq(cronJobs.id, run.jobId)).get();
    if (job) {
      db.update(cronJobs)
        .set({ lastStatus: 'error', retryCount: job.retryCount + 1, updatedAt: now })
        .where(eq(cronJobs.id, run.jobId))
        .run();
    }
  } else {
    db.update(cronJobs)
      .set({ lastStatus: 'ok', retryCount: 0, updatedAt: now })
      .where(eq(cronJobs.id, run.jobId))
      .run();
  }
}

export function getScheduleRuns(jobId: string, limit?: number): ScheduleRun[] {
  const db = getDb();
  const rows = db
    .select()
    .from(cronRuns)
    .where(eq(cronRuns.jobId, jobId))
    .orderBy(desc(cronRuns.createdAt))
    .limit(limit ?? 10)
    .all();
  return rows.map(parseRunRow);
}

export function formatLocalDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

// Convert a cron expression to a human-readable description.
// Uses the croner library to parse the expression and inspect its pattern fields.
//
// Examples:
//   "* * * * *"     -> "Every minute"
//   "0 9 * * 1-5"   -> "Every weekday at 9:00 AM"
//   "0 9 * * 0,6"   -> "Every weekend at 9:00 AM"
//   "0 9 1 * *"     -> "On the 1st of every month at 9:00 AM"
//   "30 14 * * *"   -> "Every day at 2:30 PM"
export function describeCronExpression(expr: string): string {
  try {
    const cron = new Cron(expr, { maxRuns: 0 });
    const p = (cron as unknown as { _states: { pattern: {
      minute: number[];
      hour: number[];
      day: number[];
      month: number[];
      dayOfWeek: number[];
      starDOM: boolean;
      starDOW: boolean;
    } } })._states.pattern;

    const activeMinutes = p.minute.reduce<number[]>((acc, v, i) => { if (v) acc.push(i); return acc; }, []);
    const activeHours = p.hour.reduce<number[]>((acc, v, i) => { if (v) acc.push(i); return acc; }, []);
    const activeDays = p.day.reduce<number[]>((acc, v, i) => { if (v) acc.push(i + 1); return acc; }, []);
    const activeDOW = p.dayOfWeek.reduce<number[]>((acc, v, i) => { if (v) acc.push(i); return acc; }, []);
    const activeMonths = p.month.reduce<number[]>((acc, v, i) => { if (v) acc.push(i + 1); return acc; }, []);

    const allMinutes = activeMinutes.length === 60;
    const allHours = activeHours.length === 24;
    const allDays = p.starDOM;
    const allDOW = p.starDOW;
    const allMonths = activeMonths.length === 12;

    // Format time as 12-hour clock
    function formatTime(hour: number, minute: number): string {
      const period = hour >= 12 ? 'PM' : 'AM';
      const h = hour % 12 || 12;
      const m = minute.toString().padStart(2, '0');
      return `${h}:${m} ${period}`;
    }

    // Ordinal suffix helper
    function ordinal(n: number): string {
      const s = ['th', 'st', 'nd', 'rd'];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }

    // Every minute: all fields are wildcard
    if (allMinutes && allHours && allDays && allDOW && allMonths) {
      return 'Every minute';
    }

    // Every N minutes: multiple minutes, all hours, all days
    if (!allMinutes && activeMinutes.length > 1 && allHours && allDays && allDOW && allMonths) {
      // Check if it's a regular step pattern (e.g. */5)
      if (activeMinutes.length >= 2 && activeMinutes[0] === 0) {
        const step = activeMinutes[1] - activeMinutes[0];
        const isRegularStep = activeMinutes.every((v, i) => v === i * step);
        if (isRegularStep && 60 % step === 0) {
          return `Every ${step} minutes`;
        }
      }
    }

    // Every hour: minute is fixed at one value, all hours, all days
    if (activeMinutes.length === 1 && allHours && allDays && allDOW && allMonths) {
      if (activeMinutes[0] === 0) {
        return 'Every hour';
      }
      return `Every hour at minute ${activeMinutes[0]}`;
    }

    // Every N hours: minute is fixed, multiple hours with regular stepping, all days
    if (activeMinutes.length === 1 && !allHours && activeHours.length > 1 && allDays && allDOW && allMonths) {
      if (activeHours.length >= 2 && activeHours[0] === 0) {
        const step = activeHours[1] - activeHours[0];
        const isRegularStep = activeHours.every((v, i) => v === i * step);
        if (isRegularStep && 24 % step === 0) {
          return `Every ${step} hours`;
        }
      }
    }

    // Specific time patterns: single hour and single minute
    if (activeMinutes.length === 1 && activeHours.length === 1 && allMonths) {
      const timeStr = formatTime(activeHours[0], activeMinutes[0]);

      // Check day-of-week constraints
      if (allDays && !allDOW) {
        // Weekdays: Mon-Fri (1-5)
        if (activeDOW.length === 5 && activeDOW.every((d) => d >= 1 && d <= 5)) {
          return `Every weekday at ${timeStr}`;
        }
        // Weekends: Sat, Sun (0, 6)
        if (activeDOW.length === 2 && activeDOW.includes(0) && activeDOW.includes(6)) {
          return `Every weekend at ${timeStr}`;
        }
        // Specific days of week
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const names = activeDOW.map((d) => dayNames[d]);
        return `Every ${names.join(', ')} at ${timeStr}`;
      }

      // Specific day of month
      if (!allDays && allDOW && activeDays.length === 1) {
        return `On the ${ordinal(activeDays[0])} of every month at ${timeStr}`;
      }

      // Every day at specific time
      if (allDays && allDOW) {
        return `Every day at ${timeStr}`;
      }
    }

    // Fallback: return the raw expression
    return expr;
  } catch {
    return expr;
  }
}

function parseJobRow(row: typeof cronJobs.$inferSelect): ScheduleJob {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    message: row.message,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus,
    retryCount: row.retryCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseRunRow(row: typeof cronRuns.$inferSelect): ScheduleRun {
  return {
    id: row.id,
    jobId: row.jobId,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    output: row.output,
    error: row.error,
    conversationId: row.conversationId,
    createdAt: row.createdAt,
  };
}
