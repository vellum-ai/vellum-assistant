import { Cron } from "croner";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../persistence/db-connection.js";
import { rawChanges } from "../persistence/raw-query.js";
import { scheduleJobs, scheduleRuns } from "../persistence/schema/index.js";
import { publishSchedulesChanged } from "../runtime/sync/resource-sync-events.js";
import { getLogger } from "../util/logger.js";
import { withSqliteRetry } from "../util/sqlite-retry.js";
import {
  computeNextRunAt as computeNextRunAtEngine,
  isValidScheduleExpression,
} from "./recurrence-engine.js";
import type { ScheduleSyntax } from "./recurrence-types.js";

const logger = getLogger("schedule-store");

function notifySchedulesChanged(): void {
  publishSchedulesChanged();
  void import("../background-wake/publisher.js")
    .then(({ refreshBackgroundWakeIntent }) =>
      refreshBackgroundWakeIntent("schedule-changed"),
    )
    .catch((err) =>
      logger.warn({ err }, "Failed to queue background wake refresh"),
    );
}

export type ScheduleMode =
  | "notify"
  | "execute"
  | "script"
  | "wake"
  | "workflow";
export type RoutingIntent = "single_channel" | "multi_channel" | "all_channels";
export type ScheduleStatus = "active" | "firing" | "fired" | "cancelled";

export interface ScheduleJob {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  syntax: ScheduleSyntax;
  expression: string | null;
  cronExpression: string | null;
  timezone: string | null;
  message: string;
  script: string | null;
  wakeConversationId: string | null;
  /** Saved workflow to trigger; only used when mode = 'workflow'. */
  workflowName: string | null;
  /** Args passed verbatim to the workflow run; only used when mode = 'workflow'. */
  workflowArgs: unknown;
  /** Capability manifest scoping the schedule's run; null = unconstrained. */
  capabilities: unknown | null;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  retryCount: number;
  maxRetries: number;
  retryBackoffMs: number;
  /** Script-mode execution timeout override (ms); null = use the default. */
  timeoutMs: number | null;
  /**
   * Inference profile (`llm.profiles` key) applied to the schedule's
   * LLM-executed runs; null = default main-agent model selection.
   */
  inferenceProfile: string | null;
  createdFromConversationId: string | null;
  createdBy: string;
  mode: ScheduleMode;
  routingIntent: RoutingIntent;
  routingHints: Record<string, unknown>;
  quiet: boolean;
  reuseConversation: boolean;
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

export async function createSchedule(params: {
  name: string;
  description?: string;
  cronExpression?: string | null;
  timezone?: string | null;
  message: string;
  script?: string | null;
  wakeConversationId?: string | null;
  workflowName?: string | null;
  workflowArgs?: unknown;
  capabilities?: unknown;
  enabled?: boolean;
  createdBy?: string;
  syntax?: ScheduleSyntax;
  expression?: string | null;
  nextRunAt?: number;
  mode?: ScheduleMode;
  routingIntent?: RoutingIntent;
  routingHints?: Record<string, unknown>;
  quiet?: boolean;
  reuseConversation?: boolean;
  maxRetries?: number;
  retryBackoffMs?: number;
  timeoutMs?: number | null;
  inferenceProfile?: string | null;
  createdFromConversationId?: string | null;
}): Promise<ScheduleJob> {
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

  if (params.mode === "wake" && !params.wakeConversationId) {
    throw new Error("Wake schedules require wakeConversationId");
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
  const reuseConversation = params.reuseConversation ?? false;
  const maxRetries = params.maxRetries ?? 3;
  const retryBackoffMs = params.retryBackoffMs ?? 60000;
  const timeoutMs = params.timeoutMs ?? null;
  const inferenceProfile = params.inferenceProfile ?? null;
  const createdFromConversationId = params.createdFromConversationId ?? null;
  const description = normalizeDescription(
    params.description,
    params.createdBy === "defer" ? "" : params.name,
  );

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
    description,
    enabled,
    cronExpression: expression,
    scheduleSyntax: syntax,
    timezone,
    message: params.message,
    script: params.script ?? null,
    wakeConversationId: params.wakeConversationId ?? null,
    workflowName: params.workflowName ?? null,
    workflowArgsJson:
      params.workflowArgs === undefined
        ? null
        : JSON.stringify(params.workflowArgs),
    capabilitiesJson:
      params.capabilities != null ? JSON.stringify(params.capabilities) : null,
    nextRunAt,
    lastRunAt: null as number | null,
    lastStatus: null as string | null,
    retryCount: 0,
    maxRetries,
    retryBackoffMs,
    timeoutMs,
    inferenceProfile,
    createdFromConversationId,
    createdBy: params.createdBy ?? "agent",
    mode,
    routingIntent,
    routingHintsJson: JSON.stringify(routingHints),
    quiet,
    reuseConversation,
    status: "active" as ScheduleStatus,
    createdAt: now,
    updatedAt: now,
  };

  await withSqliteRetry(() => db.insert(scheduleJobs).values(row).run(), {
    op: "createSchedule",
    context: { scheduleId: id },
  });
  notifySchedulesChanged();
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
  mode?: ScheduleMode;
  createdBy?: string;
  conversationId?: string;
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
  if (options?.mode) {
    conditions.push(eq(scheduleJobs.mode, options.mode));
  }
  if (options?.createdBy) {
    conditions.push(eq(scheduleJobs.createdBy, options.createdBy));
  }
  if (options?.conversationId) {
    conditions.push(
      eq(scheduleJobs.wakeConversationId, options.conversationId),
    );
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

export async function updateSchedule(
  id: string,
  updates: {
    name?: string;
    description?: string;
    cronExpression?: string;
    timezone?: string | null;
    message?: string;
    script?: string | null;
    enabled?: boolean;
    syntax?: ScheduleSyntax;
    expression?: string;
    mode?: ScheduleMode;
    routingIntent?: RoutingIntent;
    routingHints?: Record<string, unknown>;
    quiet?: boolean;
    reuseConversation?: boolean;
    wakeConversationId?: string | null;
    workflowName?: string | null;
    workflowArgs?: unknown;
    capabilities?: unknown;
    maxRetries?: number;
    retryBackoffMs?: number;
    timeoutMs?: number | null;
    inferenceProfile?: string | null;
    createdFromConversationId?: string | null;
  },
): Promise<ScheduleJob | null> {
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

  // Validate if expression, syntax, or timezone changed (only for recurring schedules)
  if (
    !isOneShot &&
    (updates.expression !== undefined ||
      updates.cronExpression !== undefined ||
      updates.syntax !== undefined ||
      updates.timezone !== undefined)
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
  if (updates.description !== undefined)
    set.description = normalizeDescription(updates.description);
  if (updates.cronExpression !== undefined || updates.expression !== undefined)
    set.cronExpression = newExpr;
  if (updates.syntax !== undefined) set.scheduleSyntax = newSyntax;
  if (updates.timezone !== undefined) set.timezone = updates.timezone;
  if (updates.message !== undefined) set.message = updates.message;
  if (updates.script !== undefined) set.script = updates.script;
  if (updates.enabled !== undefined) set.enabled = updates.enabled;
  if (updates.mode !== undefined) set.mode = updates.mode;
  if (updates.routingIntent !== undefined)
    set.routingIntent = updates.routingIntent;
  if (updates.routingHints !== undefined)
    set.routingHintsJson = JSON.stringify(updates.routingHints);
  if (updates.quiet !== undefined) set.quiet = updates.quiet;
  if (updates.reuseConversation !== undefined)
    set.reuseConversation = updates.reuseConversation;
  if (updates.wakeConversationId !== undefined)
    set.wakeConversationId = updates.wakeConversationId;
  if (updates.workflowName !== undefined)
    set.workflowName = updates.workflowName;
  // `workflowArgs` may legitimately be any JSON value (including null), so
  // detect presence by key rather than `!== undefined`.
  if ("workflowArgs" in updates)
    set.workflowArgsJson =
      updates.workflowArgs === undefined
        ? null
        : JSON.stringify(updates.workflowArgs);
  // `capabilities` may legitimately be any JSON value (including null), so
  // detect presence by key rather than `!== undefined`.
  if ("capabilities" in updates)
    set.capabilitiesJson =
      updates.capabilities == null
        ? null
        : JSON.stringify(updates.capabilities);
  if (updates.maxRetries !== undefined) set.maxRetries = updates.maxRetries;
  if (updates.retryBackoffMs !== undefined)
    set.retryBackoffMs = updates.retryBackoffMs;
  if (updates.timeoutMs !== undefined) set.timeoutMs = updates.timeoutMs;
  if (updates.inferenceProfile !== undefined)
    set.inferenceProfile = updates.inferenceProfile;
  if (updates.createdFromConversationId !== undefined)
    set.createdFromConversationId = updates.createdFromConversationId;

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

  await withSqliteRetry(
    () => db.update(scheduleJobs).set(set).where(eq(scheduleJobs.id, id)).run(),
    { op: "updateSchedule", context: { scheduleId: id } },
  );
  notifySchedulesChanged();

  return getSchedule(id);
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const db = getDb();
  // Capture rawChanges() inside the awaited closure: reading it after the
  // await would race other async DB work on the shared connection.
  const deleted = await withSqliteRetry(
    () => {
      db.delete(scheduleJobs).where(eq(scheduleJobs.id, id)).run();
      return rawChanges() > 0;
    },
    { op: "deleteSchedule", context: { scheduleId: id } },
  );
  if (deleted) notifySchedulesChanged();
  return deleted;
}

export interface ClaimDueSchedulesOptions {
  /** Claim only schedules whose mode is in this set. */
  includeModes?: ScheduleMode[];
  /** Claim every mode except these. Ignored when `includeModes` is set. */
  excludeModes?: ScheduleMode[];
}

/** Candidate-query mode condition for {@link claimDueSchedules}, if any. */
function modeCondition(options: ClaimDueSchedulesOptions) {
  if (options.includeModes && options.includeModes.length > 0) {
    return inArray(scheduleJobs.mode, options.includeModes);
  }
  if (options.excludeModes && options.excludeModes.length > 0) {
    return notInArray(scheduleJobs.mode, options.excludeModes);
  }
  return undefined;
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
 *
 * `options` narrows the claim by mode: the in-process scheduler excludes
 * `script` while the schedule worker owns it, and the worker claims only
 * `script`. The claim updates themselves stay keyed on id + optimistic lock,
 * so two claimers with disjoint mode sets never contend on the same row.
 */
export async function claimDueSchedules(
  now: number,
  options: ClaimDueSchedulesOptions = {},
): Promise<ScheduleJob[]> {
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
        modeCondition(options),
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

    const recurringClaimed = await withSqliteRetry(
      () => {
        db.update(scheduleJobs)
          .set(updates)
          .where(
            and(
              eq(scheduleJobs.id, row.id),
              eq(scheduleJobs.nextRunAt, row.nextRunAt),
            ),
          )
          .run();
        return rawChanges() > 0;
      },
      { op: "claimDueSchedules.recurring", context: { scheduleId: row.id } },
    );

    if (!recurringClaimed) continue;

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
        modeCondition(options),
      ),
    )
    .orderBy(asc(scheduleJobs.nextRunAt))
    .all();

  for (const row of oneShotCandidates) {
    const oneShotClaimed = await withSqliteRetry(
      () => {
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
        return rawChanges() > 0;
      },
      { op: "claimDueSchedules.oneShot", context: { scheduleId: row.id } },
    );

    if (!oneShotClaimed) continue;

    claimed.push(
      parseJobRow({
        ...row,
        status: "firing",
        lastRunAt: now,
        updatedAt: now,
      }),
    );
  }

  if (claimed.length > 0) notifySchedulesChanged();
  return claimed;
}

/**
 * Complete a one-shot schedule after successful execution.
 * Transitions status from 'firing' to 'fired' and disables the schedule.
 */
export async function completeOneShot(id: string): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const changed = await withSqliteRetry(
    () => {
      db.update(scheduleJobs)
        .set({
          status: "fired",
          enabled: false,
          updatedAt: now,
        })
        .where(and(eq(scheduleJobs.id, id), eq(scheduleJobs.status, "firing")))
        .run();
      return rawChanges() > 0;
    },
    { op: "completeOneShot", context: { scheduleId: id } },
  );
  if (changed) notifySchedulesChanged();
}

/**
 * Revert a one-shot schedule from 'firing' back to 'active' on failure.
 * Allows the schedule to be retried on the next tick.
 */
export async function failOneShot(id: string): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const changed = await withSqliteRetry(
    () => {
      db.update(scheduleJobs)
        .set({
          status: "active",
          updatedAt: now,
        })
        .where(and(eq(scheduleJobs.id, id), eq(scheduleJobs.status, "firing")))
        .run();
      return rawChanges() > 0;
    },
    { op: "failOneShot", context: { scheduleId: id } },
  );
  if (changed) notifySchedulesChanged();
}

/**
 * Re-arm a just-claimed schedule so it is due again on the very next tick,
 * WITHOUT counting as a run or bumping the retry count. Sets status back to
 * 'active' and pulls `nextRunAt` back to now: `claimDueSchedules` advances
 * `nextRunAt` for recurring jobs (and flips one-shots to 'firing'), so without
 * resetting both the claimed occurrence would be dropped until the next cron
 * time. Used when a tick claims a job it cannot yet process (e.g. a workflow
 * schedule that fired before the tool registry finished initializing at boot);
 * unlike a failure path it does not touch `retryCount`, since the deferral is
 * not the schedule's fault. Keyed by id only (no status guard) because recurring
 * claims leave the row 'active' while one-shot claims leave it 'firing', and it
 * runs immediately after the claim within the same tick.
 *
 * Also restores `enabled: true`. `claimDueSchedules` disables a row whose
 * claimed occurrence was its LAST (a one-shot, or the final fire of a finite
 * RRULE), but the due-claim query requires `enabled = true` — so a deferred
 * final occurrence would never be re-claimed and the run would be silently lost.
 * The deferred occurrence has not actually run yet, so re-enabling is correct;
 * when it later fires, the claim path re-applies the right `enabled` state.
 */
export async function deferClaimedSchedule(id: string): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const changed = await withSqliteRetry(
    () => {
      db.update(scheduleJobs)
        .set({
          status: "active",
          enabled: true,
          nextRunAt: now,
          updatedAt: now,
        })
        .where(eq(scheduleJobs.id, id))
        .run();
      return rawChanges() > 0;
    },
    { op: "deferClaimedSchedule", context: { scheduleId: id } },
  );
  if (changed) notifySchedulesChanged();
}

/**
 * Revert a one-shot from 'firing' back to 'active' and increment its
 * retry count. Used when a wake times out waiting for an idle conversation
 * — the job should be retried on the next scheduler tick.
 */
export async function retryOneShot(id: string): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const changed = await withSqliteRetry(
    () => {
      db.update(scheduleJobs)
        .set({
          status: "active",
          retryCount: sql`${scheduleJobs.retryCount} + 1`,
          updatedAt: now,
        })
        .where(and(eq(scheduleJobs.id, id), eq(scheduleJobs.status, "firing")))
        .run();
      return rawChanges() > 0;
    },
    { op: "retryOneShot", context: { scheduleId: id } },
  );
  if (changed) notifySchedulesChanged();
}

/**
 * Permanently fail a one-shot schedule by marking it as cancelled and
 * disabled. Used when a wake has exceeded its retry cap and should not
 * be retried further.
 */
export async function failOneShotPermanently(id: string): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const changed = await withSqliteRetry(
    () => {
      db.update(scheduleJobs)
        .set({
          status: "cancelled",
          enabled: false,
          lastStatus: "error",
          updatedAt: now,
        })
        .where(and(eq(scheduleJobs.id, id), eq(scheduleJobs.status, "firing")))
        .run();
      return rawChanges() > 0;
    },
    { op: "failOneShotPermanently", context: { scheduleId: id } },
  );
  if (changed) notifySchedulesChanged();
}

/**
 * Cancel a one-shot schedule. Sets status to 'cancelled' and disables it.
 * Returns true if a row was actually updated (i.e., it was in 'active' status).
 */
export async function cancelSchedule(id: string): Promise<boolean> {
  const db = getDb();
  const now = Date.now();
  const cancelled = await withSqliteRetry(
    () => {
      db.update(scheduleJobs)
        .set({
          status: "cancelled",
          enabled: false,
          updatedAt: now,
        })
        .where(and(eq(scheduleJobs.id, id), eq(scheduleJobs.status, "active")))
        .run();
      return rawChanges() > 0;
    },
    { op: "cancelSchedule", context: { scheduleId: id } },
  );
  if (cancelled) notifySchedulesChanged();
  return cancelled;
}

export async function createScheduleRun(
  jobId: string,
  conversationId: string | null,
): Promise<string> {
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  await withSqliteRetry(
    () =>
      db
        .insert(scheduleRuns)
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
        .run(),
    { op: "createScheduleRun", context: { scheduleId: jobId, runId: id } },
  );
  return id;
}

export async function setScheduleRunConversationId(
  runId: string,
  conversationId: string,
): Promise<void> {
  const db = getDb();
  await withSqliteRetry(
    () =>
      db
        .update(scheduleRuns)
        .set({ conversationId })
        .where(eq(scheduleRuns.id, runId))
        .run(),
    { op: "setScheduleRunConversationId", context: { runId } },
  );
}

export async function completeScheduleRun(
  runId: string,
  result: { status: "ok" | "error"; output?: string; error?: string },
): Promise<void> {
  const db = getDb();
  const now = Date.now();

  const run = db
    .select()
    .from(scheduleRuns)
    .where(eq(scheduleRuns.id, runId))
    .get();
  if (!run) return;

  const durationMs = now - run.startedAt;

  await withSqliteRetry(
    () =>
      db
        .update(scheduleRuns)
        .set({
          status: result.status,
          finishedAt: now,
          durationMs,
          output: result.output?.slice(0, 10_000) ?? null,
          error: result.error?.slice(0, 2000) ?? null,
        })
        .where(eq(scheduleRuns.id, runId))
        .run(),
    { op: "completeScheduleRun.run", context: { runId } },
  );

  // Update the parent job's lastStatus and retryCount
  if (result.status === "error") {
    // Increment retry count
    const job = db
      .select()
      .from(scheduleJobs)
      .where(eq(scheduleJobs.id, run.jobId))
      .get();
    if (job) {
      const changed = await withSqliteRetry(
        () => {
          db.update(scheduleJobs)
            .set({
              lastStatus: "error",
              retryCount: job.retryCount + 1,
              updatedAt: now,
            })
            .where(eq(scheduleJobs.id, run.jobId))
            .run();
          return rawChanges() > 0;
        },
        {
          op: "completeScheduleRun.jobError",
          context: { scheduleId: run.jobId },
        },
      );
      if (changed) notifySchedulesChanged();
    }
  } else {
    const changed = await withSqliteRetry(
      () => {
        db.update(scheduleJobs)
          .set({ lastStatus: "ok", retryCount: 0, updatedAt: now })
          .where(eq(scheduleJobs.id, run.jobId))
          .run();
        return rawChanges() > 0;
      },
      { op: "completeScheduleRun.jobOk", context: { scheduleId: run.jobId } },
    );
    if (changed) notifySchedulesChanged();
  }
}

/**
 * Return the conversation ID from the most recent successful run
 * for a given schedule, or null if none exists.
 */
export function getLastScheduleConversationId(jobId: string): string | null {
  const db = getDb();
  const row = db
    .select({ conversationId: scheduleRuns.conversationId })
    .from(scheduleRuns)
    .where(
      and(
        eq(scheduleRuns.jobId, jobId),
        eq(scheduleRuns.status, "ok"),
        sql`${scheduleRuns.conversationId} IS NOT NULL`,
      ),
    )
    .orderBy(desc(scheduleRuns.createdAt))
    .limit(1)
    .get();
  return row?.conversationId ?? null;
}

/**
 * List runs for a schedule, newest first. When `before` is set, only runs
 * with `createdAt` strictly older than it are returned (cursor for
 * paginating into history).
 */
export function getScheduleRuns(
  jobId: string,
  limit?: number,
  before?: number,
): ScheduleRun[] {
  const db = getDb();
  const rows = db
    .select()
    .from(scheduleRuns)
    .where(
      and(
        eq(scheduleRuns.jobId, jobId),
        before != null ? lt(scheduleRuns.createdAt, before) : undefined,
      ),
    )
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

    // Stepped or fixed minutes constrained to a contiguous range of hours,
    // every day/month (e.g. "*/30 7-23 * * *" → "Every 30 minutes, 7 AM–11 PM").
    const hoursAreContiguousRange =
      !allHours &&
      activeHours.length > 1 &&
      activeHours.every((h, i) => i === 0 || h === activeHours[i - 1] + 1);

    if (hoursAreContiguousRange && anyDayAndMonth) {
      const hourLabel = (h: number) => {
        const period = h >= 12 ? "PM" : "AM";
        return `${h % 12 || 12} ${period}`;
      };
      const rangeStr = `${hourLabel(activeHours[0])}–${hourLabel(
        activeHours[activeHours.length - 1],
      )}`;

      if (steppedMinutes && activeMinutes[0] === 0) {
        const step = activeMinutes[1] - activeMinutes[0];
        const isRegularStep = activeMinutes.every((v, i) => v === i * step);
        if (isRegularStep && 60 % step === 0) {
          return `Every ${step} minutes, ${rangeStr}`;
        }
      }
      if (fixedMinute) {
        return activeMinutes[0] === 0
          ? `Hourly, ${rangeStr}`
          : `Hourly at minute ${activeMinutes[0]}, ${rangeStr}`;
      }
    }

    // Fallback: return the raw expression
    return expr;
  } catch {
    return expr;
  }
}

/**
 * Set the next retry time for a schedule and revert one-shot status from
 * "firing" to "active" so the scheduler will claim it again when nextRetryAt
 * arrives. No-op for recurring schedules (they stay in their current status).
 */
export async function scheduleRetry(
  id: string,
  nextRetryAt: number,
): Promise<void> {
  const db = getDb();
  const now = Date.now();
  let changed = await withSqliteRetry(
    () => {
      db.update(scheduleJobs)
        .set({ nextRunAt: nextRetryAt, updatedAt: now })
        .where(eq(scheduleJobs.id, id))
        .run();
      return rawChanges() > 0;
    },
    { op: "scheduleRetry.nextRunAt", context: { scheduleId: id } },
  );
  // Revert one-shot status from "firing" to "active" so the scheduler
  // will claim it again when nextRetryAt arrives. No-op for recurring.
  const reverted = await withSqliteRetry(
    () => {
      db.update(scheduleJobs)
        .set({ status: "active", updatedAt: now })
        .where(and(eq(scheduleJobs.id, id), eq(scheduleJobs.status, "firing")))
        .run();
      return rawChanges() > 0;
    },
    { op: "scheduleRetry.revertStatus", context: { scheduleId: id } },
  );
  changed = reverted || changed;
  if (changed) notifySchedulesChanged();
}

/**
 * Reset the retry count for a schedule back to zero (e.g. after a successful run).
 */
export async function resetRetryCount(id: string): Promise<void> {
  const db = getDb();
  const changed = await withSqliteRetry(
    () => {
      db.update(scheduleJobs)
        .set({ retryCount: 0, updatedAt: Date.now() })
        .where(eq(scheduleJobs.id, id))
        .run();
      return rawChanges() > 0;
    },
    { op: "resetRetryCount", context: { scheduleId: id } },
  );
  if (changed) notifySchedulesChanged();
}

/**
 * Find schedules stuck in an in-flight state (one-shots in "firing",
 * cron runs in "running"). Used at daemon startup to recover from
 * a prior process crash.
 *
 * @param staleThresholdMs If >0, only consider rows whose lastRunAt
 *   (for one-shots) or startedAt (for runs) is older than `now - staleThresholdMs`.
 *   Pass 0 at startup (the previous process is definitely dead).
 */
export function findStaleInFlightJobs(staleThresholdMs: number = 0): Array<{
  jobId: string;
  staleRunId: string | null;
}> {
  const db = getDb();
  const cutoff = Date.now() - staleThresholdMs;

  // One-shots stuck in "firing" where lastRunAt is older than cutoff
  const staleOneShots = db
    .select({ id: scheduleJobs.id })
    .from(scheduleJobs)
    .where(
      and(
        isNull(scheduleJobs.cronExpression),
        eq(scheduleJobs.status, "firing"),
        eq(scheduleJobs.enabled, true),
        staleThresholdMs > 0 ? lte(scheduleJobs.lastRunAt, cutoff) : undefined,
      ),
    )
    .all();

  // Cron runs stuck in "running" where startedAt is older than cutoff
  const staleRuns = db
    .select({ id: scheduleRuns.id, jobId: scheduleRuns.jobId })
    .from(scheduleRuns)
    .where(
      and(
        eq(scheduleRuns.status, "running"),
        staleThresholdMs > 0 ? lte(scheduleRuns.startedAt, cutoff) : undefined,
      ),
    )
    .all();

  const result: Array<{ jobId: string; staleRunId: string | null }> = [];
  const seenJobIds = new Set<string>();

  for (const run of staleRuns) {
    result.push({ jobId: run.jobId, staleRunId: run.id });
    seenJobIds.add(run.jobId);
  }
  for (const job of staleOneShots) {
    if (!seenJobIds.has(job.id)) {
      result.push({ jobId: job.id, staleRunId: null });
    }
  }
  return result;
}

function parseJobRow(row: typeof scheduleJobs.$inferSelect): ScheduleJob {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    enabled: row.enabled,
    syntax: row.scheduleSyntax as ScheduleSyntax,
    expression: row.cronExpression,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    message: row.message,
    script: row.script ?? null,
    wakeConversationId: row.wakeConversationId ?? null,
    workflowName: row.workflowName ?? null,
    workflowArgs: parseOptionalJson(row.workflowArgsJson),
    capabilities: parseOptionalJson(row.capabilitiesJson),
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus,
    retryCount: row.retryCount,
    maxRetries: row.maxRetries ?? 3,
    retryBackoffMs: row.retryBackoffMs ?? 60000,
    timeoutMs: row.timeoutMs ?? null,
    inferenceProfile: row.inferenceProfile ?? null,
    createdFromConversationId: row.createdFromConversationId ?? null,
    createdBy: row.createdBy,
    mode: (row.mode ?? "execute") as ScheduleMode,
    routingIntent: (row.routingIntent ?? "all_channels") as RoutingIntent,
    routingHints: safeParseJson(row.routingHintsJson),
    quiet: row.quiet ?? false,
    reuseConversation: row.reuseConversation ?? false,
    status: (row.status ?? "active") as ScheduleStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeDescription(
  value: string | undefined,
  fallback = "",
): string {
  const normalized = value?.trim() ?? "";
  return normalized || fallback;
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

/**
 * Parse a nullable JSON column into an arbitrary value. Unlike
 * {@link safeParseJson}, the result is not coerced to an object — workflow
 * args may be any JSON value — and an absent/unparseable column yields null.
 */
function parseOptionalJson(json: string | null | undefined): unknown {
  if (json == null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
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
