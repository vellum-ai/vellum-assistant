import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { Cron } from 'croner';
import { getDb } from '../memory/db.js';
import { scheduleJobs, scheduleRuns } from '../memory/schema.js';
import { computeNextRunAt as computeNextRunAtEngine, isValidScheduleExpression } from './recurrence-engine.js';
import type { ScheduleSyntax } from './recurrence-types.js';

export interface ScheduleJob {
  id: string;
  name: string;
  enabled: boolean;
  syntax: ScheduleSyntax;
  expression: string;
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
    throw new Error(`Schedule expression "${cronExpression}" has no upcoming runs`);
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
  syntax?: ScheduleSyntax;
  expression?: string;
}): ScheduleJob {
  // Resolve syntax and expression: prefer explicit values, fall back to cron default
  const syntax: ScheduleSyntax = params.syntax ?? 'cron';
  const expression = params.expression ?? params.cronExpression;

  const spec = { syntax, expression, timezone: params.timezone };
  if (!isValidScheduleExpression(spec)) {
    throw new Error(`Invalid ${syntax} expression: "${expression}"`);
  }

  const db = getDb();
  const id = uuid();
  const now = Date.now();
  const enabled = params.enabled ?? true;
  const timezone = params.timezone ?? null;
  const nextRunAt = enabled ? computeNextRunAtEngine(spec) : 0;

  const row = {
    id,
    name: params.name,
    enabled,
    cronExpression: expression,
    scheduleSyntax: syntax,
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

  db.insert(scheduleJobs).values(row).run();
  return parseJobRow(row);
}

export function getSchedule(id: string): ScheduleJob | null {
  const db = getDb();
  const row = db
    .select()
    .from(scheduleJobs)
    .where(eq(scheduleJobs.id, id))
    .get();
  if (!row) return null;
  return parseJobRow(row);
}

export function listSchedules(options?: { enabledOnly?: boolean }): ScheduleJob[] {
  const db = getDb();
  const conditions = options?.enabledOnly ? eq(scheduleJobs.enabled, true) : undefined;
  const rows = db
    .select()
    .from(scheduleJobs)
    .where(conditions)
    .orderBy(asc(scheduleJobs.nextRunAt))
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
    syntax?: ScheduleSyntax;
    expression?: string;
  },
): ScheduleJob | null {
  const db = getDb();
  const existing = db.select().from(scheduleJobs).where(eq(scheduleJobs.id, id)).get();
  if (!existing) return null;

  // Resolve the effective syntax and expression after this update
  const newSyntax = updates.syntax ?? (existing.scheduleSyntax as ScheduleSyntax) ?? 'cron';
  const newExpr = updates.expression ?? updates.cronExpression ?? existing.cronExpression;
  const newTimezone = updates.timezone !== undefined ? updates.timezone : existing.timezone;
  const newEnabled = updates.enabled !== undefined ? updates.enabled : existing.enabled;

  // Validate if expression or syntax changed
  if (updates.expression !== undefined || updates.cronExpression !== undefined || updates.syntax !== undefined) {
    const spec = { syntax: newSyntax, expression: newExpr, timezone: newTimezone };
    if (!isValidScheduleExpression(spec)) {
      throw new Error(`Invalid ${newSyntax} expression: "${newExpr}"`);
    }
  }

  const now = Date.now();
  const set: Record<string, unknown> = { updatedAt: now };

  if (updates.name !== undefined) set.name = updates.name;
  if (updates.cronExpression !== undefined || updates.expression !== undefined) set.cronExpression = newExpr;
  if (updates.syntax !== undefined) set.scheduleSyntax = newSyntax;
  if (updates.timezone !== undefined) set.timezone = updates.timezone;
  if (updates.message !== undefined) set.message = updates.message;
  if (updates.enabled !== undefined) set.enabled = updates.enabled;

  // Recompute nextRunAt if schedule timing may have changed
  if (
    updates.cronExpression !== undefined ||
    updates.expression !== undefined ||
    updates.syntax !== undefined ||
    updates.timezone !== undefined ||
    updates.enabled !== undefined
  ) {
    const spec = { syntax: newSyntax, expression: newExpr, timezone: newTimezone };
    set.nextRunAt = newEnabled ? computeNextRunAtEngine(spec) : 0;
  }

  db.update(scheduleJobs).set(set).where(eq(scheduleJobs.id, id)).run();

  return getSchedule(id);
}

export function deleteSchedule(id: string): boolean {
  const db = getDb();
  const result = db.delete(scheduleJobs).where(eq(scheduleJobs.id, id)).run() as unknown as { changes?: number };
  return (result.changes ?? 0) > 0;
}

/**
 * Claim due recurrence schedules atomically. For each candidate where
 * enabled=true and next_run_at <= now, we advance next_run_at using
 * optimistic locking on the old value to prevent double-claiming by
 * concurrent ticks. Works for both cron and RRULE syntax.
 */
export function claimDueSchedules(now: number): ScheduleJob[] {
  const db = getDb();
  const candidates = db
    .select()
    .from(scheduleJobs)
    .where(and(eq(scheduleJobs.enabled, true), lte(scheduleJobs.nextRunAt, now)))
    .orderBy(asc(scheduleJobs.nextRunAt))
    .all();

  const claimed: ScheduleJob[] = [];
  for (const row of candidates) {
    let newNextRunAt: number | null;
    let exhausted = false;
    try {
      const syntax = (row.scheduleSyntax as ScheduleSyntax) ?? 'cron';
      newNextRunAt = computeNextRunAtEngine({
        syntax,
        expression: row.cronExpression,
        timezone: row.timezone,
      });
    } catch (err) {
      // Only treat "no upcoming runs" as exhaustion — rethrow other failures
      // (e.g. invalid RRULE lines, unsupported syntax) so they surface instead
      // of silently disabling a schedule that has a configuration bug.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('no upcoming runs')) throw err;
      // Expired schedules fire their final pending due run then auto-disable,
      // ensuring no due run is silently dropped.
      newNextRunAt = null;
      exhausted = true;
    }

    // Optimistic lock: only update if nextRunAt hasn't changed
    const updates: Record<string, unknown> = {
      lastRunAt: now,
      updatedAt: now,
    };
    if (exhausted) {
      updates.nextRunAt = 0;
      updates.enabled = false;
    } else {
      updates.nextRunAt = newNextRunAt!;
    }

    const result = db
      .update(scheduleJobs)
      .set(updates)
      .where(and(eq(scheduleJobs.id, row.id), eq(scheduleJobs.nextRunAt, row.nextRunAt)))
      .run() as unknown as { changes?: number };

    if ((result.changes ?? 0) === 0) continue;

    claimed.push(parseJobRow({
      ...row,
      nextRunAt: exhausted ? 0 : newNextRunAt!,
      lastRunAt: now,
      updatedAt: now,
      enabled: exhausted ? false : row.enabled,
    }));
  }
  return claimed;
}

export function createScheduleRun(jobId: string, conversationId: string): string {
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  db.insert(scheduleRuns).values({
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

  const run = db.select().from(scheduleRuns).where(eq(scheduleRuns.id, runId)).get();
  if (!run) return;

  const durationMs = now - run.startedAt;

  db.update(scheduleRuns)
    .set({
      status: result.status,
      finishedAt: now,
      durationMs,
      output: result.output?.slice(0, 10_000) ?? null,
      error: result.error?.slice(0, 2000) ?? null,
    })
    .where(eq(scheduleRuns.id, runId))
    .run();

  // Update the parent job's lastStatus and retryCount
  if (result.status === 'error') {
    // Increment retry count
    const job = db.select().from(scheduleJobs).where(eq(scheduleJobs.id, run.jobId)).get();
    if (job) {
      db.update(scheduleJobs)
        .set({ lastStatus: 'error', retryCount: job.retryCount + 1, updatedAt: now })
        .where(eq(scheduleJobs.id, run.jobId))
        .run();
    }
  } else {
    db.update(scheduleJobs)
      .set({ lastStatus: 'ok', retryCount: 0, updatedAt: now })
      .where(eq(scheduleJobs.id, run.jobId))
      .run();
  }
}

export function getScheduleRuns(jobId: string, limit?: number): ScheduleRun[] {
  const db = getDb();
  const rows = db
    .select()
    .from(scheduleRuns)
    .where(eq(scheduleRuns.jobId, jobId))
    .orderBy(desc(scheduleRuns.createdAt))
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
// Only applicable to cron syntax; RRULE schedules should display the
// raw expression text instead.
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

function parseJobRow(row: typeof scheduleJobs.$inferSelect): ScheduleJob {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    syntax: (row.scheduleSyntax as ScheduleSyntax) ?? 'cron',
    expression: row.cronExpression,
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

function parseRunRow(row: typeof scheduleRuns.$inferSelect): ScheduleRun {
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
