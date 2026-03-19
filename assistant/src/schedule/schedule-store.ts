import { Cron } from "croner";
import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../memory/db.js";
import { rawChanges } from "../memory/raw-query.js";
import { scheduleJobs, scheduleRuns } from "../memory/schema.js";
import { getLogger } from "../util/logger.js";
import {
  computeNextRunAt as computeNextRunAtEngine,
  isValidScheduleExpression,
} from "./recurrence-engine.js";
import type { ScheduleSyntax } from "./recurrence-types.js";

const logger = getLogger("schedule-store");

export type ScheduleMode = "notify" | "execute";
export type RoutingIntent = "single_channel" | "multi_channel" | "all_channels";
export type ScheduleStatus = "active" | "firing" | "fired" | "cancelled";

export interface ScheduleJob {
  id: string;
  name: string;
  enabled: boolean;
  syntax: ScheduleSyntax;
  expression: string | null;
  cronExpression: string | null;
  timezone: string | null;
  message: string;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  retryCount: number;
  createdBy: string;
  mode: ScheduleMode;
  routingIntent: RoutingIntent;
  routingHints: Record<string, unknown>;
  quiet: boolean;
  status: ScheduleStatus;
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

export function computeNextRunAt(
  cronExpression: string,
  timezone?: string | null,
): number {
  const cron = new Cron(cronExpression, {
    timezone: timezone ?? undefined,
  });
  const next = cron.nextRun();
  if (!next) {
    throw new Error(
      `Schedule expression "${cronExpression}" has no upcoming runs`,
    );
  }
  return next.getTime();
}

export function createSchedule(params: {
  name: string;
  cronExpression?: string | null;
  timezone?: string | null;
  message: string;
  enabled?: boolean;
  createdBy?: string;
  syntax?: ScheduleSyntax;
  expression?: string | null;
  nextRunAt?: number;
  mode?: ScheduleMode;
  routingIntent?: RoutingIntent;
  routingHints?: Record<string, unknown>;
  quiet?: boolean;
}): ScheduleJob {
  const expression = params.expression ?? params.cronExpression ?? null;
  const isOneShot = expression == null;
  const syntax = params.syntax ?? "cron";

  if (isOneShot) {
    // One-shot schedules must have nextRunAt provided directly
    if (params.nextRunAt == null) {
      throw new Error(
        "One-shot schedules (no expression) require nextRunAt to be provided",
      );
    }
  } else {
    const spec = { syntax, expression, timezone: params.timezone };
    if (!isValidScheduleExpression(spec)) {
      throw new Error(`Invalid ${syntax} expression: "${expression}"`);
    }
  }

  const db = getDb();
  const id = uuid();
  const now = Date.now();
  const enabled = params.enabled ?? true;
  const timezone = params.timezone ?? null;
  const mode = params.mode ?? "execute";
  const routingIntent = params.routingIntent ?? "all_channels";
  const routingHints = params.routingHints ?? {};
  const quiet = params.quiet ?? false;

  let nextRunAt: number;
  if (isOneShot) {
    nextRunAt = params.nextRunAt!;
  } else {
    nextRunAt = enabled
      ? computeNextRunAtEngine({ syntax, expression: expression!, timezone })
      : 0;
  }

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
    createdBy: params.createdBy ?? "agent",
    mode,
    routingIntent,
    routingHintsJson: JSON.stringify(routingHints),
    quiet,
    status: "active" as ScheduleStatus,
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

export function countSchedules(): { total: number; enabled: number } {
  const db = getDb();
  const row = db
    .select({
      total: sql<number>`COUNT(*)`,
      enabled: sql<number>`SUM(CASE WHEN ${scheduleJobs.enabled} THEN 1 ELSE 0 END)`,
    })
    .from(scheduleJobs)
    .get();
  return { total: row?.total ?? 0, enabled: row?.enabled ?? 0 };
}

export function listSchedules(options?: {
  enabledOnly?: boolean;
  oneShotOnly?: boolean;
  recurringOnly?: boolean;
}): ScheduleJob[] {
  const db = getDb();
  const conditions = [];
  if (options?.enabledOnly) {
    conditions.push(eq(scheduleJobs.enabled, true));
  }
  if (options?.oneShotOnly) {
    conditions.push(isNull(scheduleJobs.cronExpression));
  }
  if (options?.recurringOnly) {
    conditions.push(sql`${scheduleJobs.cronExpression} IS NOT NULL`);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = db
    .select()
    .from(scheduleJobs)
    .where(where)
    .orderBy(asc(scheduleJobs.nextRunAt))
    .all();
  return rows.map(parseJobRow);
}

/**
 * Return enabled schedules whose next run falls within a time window.
 * Used by the memory brief compiler to surface due-soon schedule entries.
 */
export function getDueSoonSchedules(
  now: number,
  horizonMs: number,
): ScheduleJob[] {
  const db = getDb();
  const cutoff = now + horizonMs;
  const rows = db
    .select()
    .from(scheduleJobs)
    .where(
      and(eq(scheduleJobs.enabled, true), lte(scheduleJobs.nextRunAt, cutoff)),
    )
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
    mode?: ScheduleMode;
    routingIntent?: RoutingIntent;
    routingHints?: Record<string, unknown>;
    quiet?: boolean;
  },
): ScheduleJob | null {
  const db = getDb();
  const existing = db
    .select()
    .from(scheduleJobs)
    .where(eq(scheduleJobs.id, id))
    .get();
  if (!existing) return null;

  // Resolve the effective syntax and expression after this update
  const newSyntax =
    updates.syntax ?? (existing.scheduleSyntax as ScheduleSyntax);
  const newExpr =
    updates.expression ?? updates.cronExpression ?? existing.cronExpression;
  const newTimezone =
    updates.timezone !== undefined ? updates.timezone : existing.timezone;
  const newEnabled =
    updates.enabled !== undefined ? updates.enabled : existing.enabled;

  const isOneShot = newExpr == null;

  // Validate if expression or syntax changed (only for recurring schedules)
  if (
    !isOneShot &&
    (updates.expression !== undefined ||
      updates.cronExpression !== undefined ||
      updates.syntax !== undefined)
  ) {
    const spec = {
      syntax: newSyntax,
      expression: newExpr,
      timezone: newTimezone,
    };
    if (!isValidScheduleExpression(spec)) {
      throw new Error(`Invalid ${newSyntax} expression: "${newExpr}"`);
    }
  }

  const now = Date.now();
  const set: Record<string, unknown> = { updatedAt: now };

  if (updates.name !== undefined) set.name = updates.name;
  if (updates.cronExpression !== undefined || updates.expression !== undefined)
    set.cronExpression = newExpr;
  if (updates.syntax !== undefined) set.scheduleSyntax = newSyntax;
  if (updates.timezone !== undefined) set.timezone = updates.timezone;
  if (updates.message !== undefined) set.message = updates.message;
  if (updates.enabled !== undefined) set.enabled = updates.enabled;
  if (updates.mode !== undefined) set.mode = updates.mode;
  if (updates.routingIntent !== undefined)
    set.routingIntent = updates.routingIntent;
  if (updates.routingHints !== undefined)
    set.routingHintsJson = JSON.stringify(updates.routingHints);
  if (updates.quiet !== undefined) set.quiet = updates.quiet;

  // Recompute nextRunAt if schedule timing may have changed (only for recurring)
  if (
    !isOneShot &&
    (updates.cronExpression !== undefined ||
      updates.expression !== undefined ||
      updates.syntax !== undefined ||
      updates.timezone !== undefined ||
      updates.enabled !== undefined)
  ) {
    const spec = {
      syntax: newSyntax,
      expression: newExpr!,
      timezone: newTimezone,
    };
    set.nextRunAt = newEnabled ? computeNextRunAtEngine(spec) : 0;
  }

  db.update(scheduleJobs).set(set).where(eq(scheduleJobs.id, id)).run();

  return getSchedule(id);
}

export function deleteSchedule(id: string): boolean {
  const db = getDb();
  db.delete(scheduleJobs).where(eq(scheduleJobs.id, id)).run();
  return rawChanges() > 0;
}

/**
 * Claim due schedules atomically. Handles both recurring and one-shot schedules.
 *
 * For recurring schedules: advance next_run_at using optimistic locking on the
 * old value to prevent double-claiming by concurrent ticks. Works for both
 * cron and RRULE syntax.
 *
 * For one-shot schedules: transition status from 'active' to 'firing' where
 * next_run_at <= now and enabled = true and cron_expression IS NULL.
 */
export function claimDueSchedules(now: number): ScheduleJob[] {
  const db = getDb();
  const claimed: ScheduleJob[] = [];

  // ── Recurring schedules ──────────────────────────────────────────
  const recurringCandidates = db
    .select()
    .from(scheduleJobs)
    .where(
      and(
        eq(scheduleJobs.enabled, true),
        lte(scheduleJobs.nextRunAt, now),
        sql`${scheduleJobs.cronExpression} IS NOT NULL`,
      ),
    )
    .orderBy(asc(scheduleJobs.nextRunAt))
    .all();

  for (const row of recurringCandidates) {
    let newNextRunAt: number | null;
    let exhausted = false;
    try {
      const syntax = row.scheduleSyntax as ScheduleSyntax;
      newNextRunAt = computeNextRunAtEngine({
        syntax,
        expression: row.cronExpression!,
        timezone: row.timezone,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("no upcoming runs")) {
        // Log but don't abort — one bad schedule shouldn't block everything
        logger.warn(
          { err, scheduleId: row.id },
          "Failed to compute next run for schedule",
        );
        continue;
      }
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

    db.update(scheduleJobs)
      .set(updates)
      .where(
        and(
          eq(scheduleJobs.id, row.id),
          eq(scheduleJobs.nextRunAt, row.nextRunAt),
        ),
      )
      .run();

    if (rawChanges() === 0) continue;

    claimed.push(
      parseJobRow({
        ...row,
        nextRunAt: exhausted ? 0 : newNextRunAt!,
        lastRunAt: now,
        updatedAt: now,
        enabled: exhausted ? false : row.enabled,
      }),
    );
  }

  // ── One-shot schedules ───────────────────────────────────────────
  const oneShotCandidates = db
    .select()
    .from(scheduleJobs)
    .where(
      and(
        isNull(scheduleJobs.cronExpression),
        eq(scheduleJobs.status, "active"),
        lte(scheduleJobs.nextRunAt, now),
        eq(scheduleJobs.enabled, true),
      ),
    )
    .orderBy(asc(scheduleJobs.nextRunAt))
    .all();

  for (const row of oneShotCandidates) {
    db.update(scheduleJobs)
      .set({
        status: "firing",
        lastRunAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(scheduleJobs.id, row.id), eq(scheduleJobs.status, "active")),
      )
      .run();

    if (rawChanges() === 0) continue;

    claimed.push(
      parseJobRow({
        ...row,
        status: "firing",
        lastRunAt: now,
        updatedAt: now,
      }),
    );
  }

  return claimed;
}

/**
 * Complete a one-shot schedule after successful execution.
 * Transitions status from 'firing' to 'fired' and disables the schedule.
 */
export function completeOneShot(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.update(scheduleJobs)
    .set({
      status: "fired",
      enabled: false,
      updatedAt: now,
    })
    .where(and(eq(scheduleJobs.id, id), eq(scheduleJobs.status, "firing")))
    .run();
}

/**
 * Revert a one-shot schedule from 'firing' back to 'active' on failure.
 * Allows the schedule to be retried on the next tick.
 */
export function failOneShot(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.update(scheduleJobs)
    .set({
      status: "active",
      updatedAt: now,
    })
    .where(and(eq(scheduleJobs.id, id), eq(scheduleJobs.status, "firing")))
    .run();
}

/**
 * Cancel a one-shot schedule. Sets status to 'cancelled' and disables it.
 * Returns true if a row was actually updated (i.e., it was in 'active' status).
 */
export function cancelSchedule(id: string): boolean {
  const db = getDb();
  const now = Date.now();
  db.update(scheduleJobs)
    .set({
      status: "cancelled",
      enabled: false,
      updatedAt: now,
    })
    .where(and(eq(scheduleJobs.id, id), eq(scheduleJobs.status, "active")))
    .run();
  return rawChanges() > 0;
}

export function createScheduleRun(
  jobId: string,
  conversationId: string,
): string {
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  db.insert(scheduleRuns)
    .values({
      id,
      jobId,
      status: "running",
      startedAt: now,
      finishedAt: null,
      durationMs: null,
      output: null,
      error: null,
      conversationId,
      createdAt: now,
    })
    .run();
  return id;
}

export function completeScheduleRun(
  runId: string,
  result: { status: "ok" | "error"; output?: string; error?: string },
): void {
  const db = getDb();
  const now = Date.now();

  const run = db
    .select()
    .from(scheduleRuns)
    .where(eq(scheduleRuns.id, runId))
    .get();
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
  if (result.status === "error") {
    // Increment retry count
    const job = db
      .select()
      .from(scheduleJobs)
      .where(eq(scheduleJobs.id, run.jobId))
      .get();
    if (job) {
      db.update(scheduleJobs)
        .set({
          lastStatus: "error",
          retryCount: job.retryCount + 1,
          updatedAt: now,
        })
        .where(eq(scheduleJobs.id, run.jobId))
        .run();
    }
  } else {
    db.update(scheduleJobs)
      .set({ lastStatus: "ok", retryCount: 0, updatedAt: now })
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
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

// Convert a cron expression to a human-readable description.
// Only applicable to cron syntax; RRULE schedules should display the
// raw expression text instead.
// Returns "One-time" for null expressions (one-shot schedules).
//
// Examples:
//   null                -> "One-time"
//   "* * * * *"         -> "Every minute"
//   "0 9 * * 1-5"       -> "Every weekday at 9:00 AM"
//   "0 9 * * 0,6"       -> "Every weekend at 9:00 AM"
//   "0 9 1 * *"         -> "On the 1st of every month at 9:00 AM"
//   "30 14 * * *"       -> "Every day at 2:30 PM"
export function describeCronExpression(expr: string | null): string {
  if (!expr) return "One-time";
  try {
    const cron = new Cron(expr, { maxRuns: 0 });
    // Access Croner internal state to extract the parsed cron pattern.
    // This is fragile but necessary — Croner doesn't expose a public API for this.
    const cronInternal = cron as unknown as Record<string, unknown>;
    const states = cronInternal._states;
    if (!states || typeof states !== "object") return expr;
    const p = (states as Record<string, unknown>).pattern;
    if (!p || typeof p !== "object") return expr;
    const pattern = p as {
      minute: number[];
      hour: number[];
      day: number[];
      month: number[];
      dayOfWeek: number[];
      starDOM: boolean;
      starDOW: boolean;
    };

    const activeMinutes = pattern.minute.reduce<number[]>((acc, v, i) => {
      if (v) acc.push(i);
      return acc;
    }, []);
    const activeHours = pattern.hour.reduce<number[]>((acc, v, i) => {
      if (v) acc.push(i);
      return acc;
    }, []);
    const activeDays = pattern.day.reduce<number[]>((acc, v, i) => {
      if (v) acc.push(i + 1);
      return acc;
    }, []);
    const activeDOW = pattern.dayOfWeek.reduce<number[]>((acc, v, i) => {
      if (v) acc.push(i);
      return acc;
    }, []);
    const activeMonths = pattern.month.reduce<number[]>((acc, v, i) => {
      if (v) acc.push(i + 1);
      return acc;
    }, []);

    const allMinutes = activeMinutes.length === 60;
    const allHours = activeHours.length === 24;
    const allDays = pattern.starDOM;
    const allDOW = pattern.starDOW;
    const allMonths = activeMonths.length === 12;

    const fixedMinute = activeMinutes.length === 1;
    const fixedHour = activeHours.length === 1;
    const fixedTime = fixedMinute && fixedHour;
    const steppedMinutes = !allMinutes && activeMinutes.length > 1;
    const steppedHours = !allHours && activeHours.length > 1;
    const anyDay = allDays && allDOW;
    const anyDayAndMonth = anyDay && allMonths;

    // Format time as 12-hour clock
    function formatTime(hour: number, minute: number): string {
      const period = hour >= 12 ? "PM" : "AM";
      const h = hour % 12 || 12;
      const m = minute.toString().padStart(2, "0");
      return `${h}:${m} ${period}`;
    }

    // Ordinal suffix helper
    function ordinal(n: number): string {
      const s = ["th", "st", "nd", "rd"];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }

    if (allMinutes && allHours && anyDayAndMonth) {
      return "Every minute";
    }

    if (steppedMinutes && allHours && anyDayAndMonth) {
      if (activeMinutes.length >= 2 && activeMinutes[0] === 0) {
        const step = activeMinutes[1] - activeMinutes[0];
        const isRegularStep = activeMinutes.every((v, i) => v === i * step);
        if (isRegularStep && 60 % step === 0) {
          return `Every ${step} minutes`;
        }
      }
    }

    if (fixedMinute && allHours && anyDayAndMonth) {
      if (activeMinutes[0] === 0) {
        return "Every hour";
      }
      return `Every hour at minute ${activeMinutes[0]}`;
    }

    if (fixedMinute && steppedHours && anyDayAndMonth) {
      if (activeHours.length >= 2 && activeHours[0] === 0) {
        const step = activeHours[1] - activeHours[0];
        const isRegularStep = activeHours.every((v, i) => v === i * step);
        if (isRegularStep && 24 % step === 0) {
          return `Every ${step} hours`;
        }
      }
    }

    if (fixedTime && allMonths) {
      const timeStr = formatTime(activeHours[0], activeMinutes[0]);

      if (allDays && !allDOW) {
        if (
          activeDOW.length === 5 &&
          activeDOW.every((d) => d >= 1 && d <= 5)
        ) {
          return `Every weekday at ${timeStr}`;
        }
        if (
          activeDOW.length === 2 &&
          activeDOW.includes(0) &&
          activeDOW.includes(6)
        ) {
          return `Every weekend at ${timeStr}`;
        }
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const names = activeDOW.map((d) => dayNames[d]);
        return `Every ${names.join(", ")} at ${timeStr}`;
      }

      if (!allDays && allDOW && activeDays.length === 1) {
        return `On the ${ordinal(activeDays[0])} of every month at ${timeStr}`;
      }

      if (anyDay) {
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
    syntax: row.scheduleSyntax as ScheduleSyntax,
    expression: row.cronExpression,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    message: row.message,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus,
    retryCount: row.retryCount,
    createdBy: row.createdBy,
    mode: (row.mode ?? "execute") as ScheduleMode,
    routingIntent: (row.routingIntent ?? "all_channels") as RoutingIntent,
    routingHints: safeParseJson(row.routingHintsJson),
    quiet: row.quiet ?? false,
    status: (row.status ?? "active") as ScheduleStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeParseJson(
  json: string | null | undefined,
): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
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
