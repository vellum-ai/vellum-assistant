/**
 * Route handlers for schedule management.
 *
 * All routes are served by both the HTTP server and the IPC server via
 * the shared ROUTES array.
 */

import { z } from "zod";

import { getOrCreateConversation } from "../../daemon/conversation-store.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../../daemon/trust-context.js";
import { bootstrapConversation } from "../../persistence/conversation-bootstrap.js";
import { getConversation } from "../../persistence/conversation-crud.js";
import {
  getUsageCostForRun,
  listRunConversationIds,
} from "../../persistence/llm-usage-store.js";
import { isDeferSchedule } from "../../schedule/defer-provenance.js";
import { validateScheduleInferenceProfile } from "../../schedule/inference-profile.js";
import { declarationExistsOnDisk } from "../../schedule/plugin-schedule-declarations.js";
import { isPluginSchedulesEnabled } from "../../schedule/plugin-schedules-gate.js";
import {
  describeRRuleExpression,
  isSingleFireRRule,
} from "../../schedule/recurrence-engine.js";
import { normalizeScheduleSyntax } from "../../schedule/recurrence-types.js";
import {
  runScript,
  validateScriptTimeoutMs,
} from "../../schedule/run-script.js";
import {
  cancelSchedule,
  completeScheduleRun,
  createSchedule,
  createScheduleRun,
  deleteSchedule,
  describeCronExpression,
  getLastScheduleConversationId,
  getSchedule,
  getScheduleRuns,
  listSchedules,
  resolveScheduleConversationGroupId,
  type ScheduleJob,
  setUserEnabled,
  updateSchedule,
} from "../../schedule/schedule-store.js";
import { getScheduleUsageSummaries } from "../../schedule/schedule-usage-store.js";
import { buildWakeScheduleOptions } from "../../schedule/wake-schedule-options.js";
import { initializeTools } from "../../tools/registry.js";
import { UserError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { normalizeCapabilityManifest } from "../../workflows/capabilities.js";
import { getWorkflowRunManager } from "../../workflows/run-manager.js";
import { isOwnerCaller } from "../auth/owner-caller.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { parseEpochMillisRange } from "./epoch-millis-range.js";
import {
  BadRequestError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from "./errors.js";
import {
  paginateRuns,
  parseRunsBeforeCursor,
  parseRunsLimit,
  RUNS_NEXT_CURSOR_SCHEMA,
  RUNS_PAGINATION_QUERY_PARAMS,
} from "./runs-pagination.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("schedule-routes");

/**
 * Refuse a state change that touches a deferred-wake schedule unless the caller
 * holds owner authority right now ({@link isOwnerCaller}: a local IPC caller,
 * or the current bound vellum guardian).
 *
 * A wake row is guardian-owned deferral state. Its target and trigger text
 * decide what an unattended, potentially guardian-trust turn will do, and even
 * the transitions that cannot elevate (enabling, cancelling, deleting) decide
 * whether and when that turn runs at all. The generic schedule editor is shared
 * with ordinary schedules and is reachable by any `settings.write` caller, so
 * it applies this narrower bar for wake rows only. Non-wake schedules are
 * unaffected.
 *
 * Applied to a schedule's CURRENT mode and to its RESULTING mode, so a caller
 * can neither edit an existing wake row nor turn another schedule into one.
 */
async function assertWakeMutationAllowed(
  existing: ScheduleJob | null,
  resultingMode: string | undefined,
  headers: Record<string, string> | undefined,
): Promise<void> {
  const touchesWake = existing?.mode === "wake" || resultingMode === "wake";
  if (!touchesWake) {
    return;
  }
  if (await isOwnerCaller(headers)) {
    return;
  }
  throw new ForbiddenError(
    "Deferred wake schedules can only be changed by the assistant's owner",
  );
}

// ---------------------------------------------------------------------------
// Response schemas (shared by all schedule routes)
// ---------------------------------------------------------------------------

const scheduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  syntax: z.enum(["cron", "rrule"]),
  expression: z.string().nullable(),
  cronExpression: z.string().nullable(),
  timezone: z.string().nullable(),
  message: z.string(),
  script: z.string().nullable(),
  nextRunAt: z.number(),
  lastRunAt: z.number().nullable(),
  lastStatus: z.string().nullable(),
  retryCount: z.number(),
  maxRetries: z.number(),
  retryBackoffMs: z.number(),
  timeoutMs: z.number().nullable(),
  inferenceProfile: z.string().nullable(),
  groupId: z.string().nullable(),
  createdFromConversationId: z.string().nullable(),
  createdFromConversationExists: z.boolean(),
  createdFromConversationArchivedAt: z.number().nullable(),
  description: z.string(),
  cadenceDescription: z.string(),
  mode: z.enum(["notify", "execute", "script", "wake", "workflow"]),
  status: z.enum(["active", "firing", "fired", "cancelled"]),
  routingIntent: z.enum(["single_channel", "multi_channel", "all_channels"]),
  reuseConversation: z.boolean(),
  wakeConversationId: z.string().nullable(),
  workflowName: z.string().nullable(),
  sourceKey: z
    .string()
    .nullable()
    .describe(
      "Plugin declaration this schedule mirrors (plugin:<pluginName>/<scheduleName>); null for user-created schedules",
    ),
  userEnabled: z
    .boolean()
    .nullable()
    .describe(
      "User enable/disable override on a plugin-sourced schedule; null when the declaration's own enabled value applies. Always null for user-created schedules.",
    ),
  isOneShot: z.boolean(),
  // A deferred wake ("remind me about this tomorrow") is an ordinary schedule
  // row created by the defer path, distinguishable only by `createdBy`, which
  // is not otherwise projected. Clients need it to separate the user's named
  // schedules from their reminders when listing what a change affects.
  isDeferred: z.boolean(),
});

const scheduleRunSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  status: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  conversationId: z.string().nullable(),
  conversationExists: z.boolean(),
  conversationArchivedAt: z.number().nullable(),
  // Every real conversation this firing touched. Script runs store a
  // synthetic "script:<jobId>" sentinel in the legacy `conversationId` field,
  // so their real conversations are recovered from the usage ledger via
  // `cron_run_id`. Execute and wake runs contribute their legacy pointer as
  // well. A pruned conversation keeps its entry with `exists` set to false so
  // the UI can label it as unavailable.
  conversations: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      exists: z.boolean(),
      archivedAt: z.number().nullable(),
    }),
  ),
  estimatedCostUsd: z.number(),
  createdAt: z.number(),
});

const scheduleUsageSummarySchema = z.object({
  scheduleId: z.string(),
  runCount: z.number(),
  totalEstimatedCostUsd: z.number(),
  eventCount: z.number(),
});

// ---------------------------------------------------------------------------
// Handlers (transport-agnostic)
// ---------------------------------------------------------------------------

interface CreatedFromConversationState {
  exists: boolean;
  archivedAt: number | null;
}

function getCreatedFromConversationState(
  conversationId: string | null,
  cache: Map<string, CreatedFromConversationState>,
): CreatedFromConversationState {
  if (!conversationId) {
    return { exists: false, archivedAt: null };
  }

  const cached = cache.get(conversationId);
  if (cached) {
    return cached;
  }

  const conversation = getConversation(conversationId);
  const state = {
    exists: conversation !== null,
    archivedAt: conversation?.archivedAt ?? null,
  };
  cache.set(conversationId, state);
  return state;
}

function getCadenceDescription(
  job: Pick<ScheduleJob, "syntax" | "cronExpression" | "expression">,
): string {
  if (job.cronExpression === null) {
    return describeCronExpression(job.cronExpression);
  }
  if (job.syntax === "cron") {
    return describeCronExpression(job.cronExpression);
  }
  return describeRRuleExpression(job.cronExpression);
}

/**
 * Whether a schedule still has a firing ahead of it. `fired` and `cancelled`
 * are the two terminal states a one-shot lands in; everything else (including
 * a disabled row, which fires again once re-enabled) can still run.
 */
function canScheduleStillRun(job: Pick<ScheduleJob, "status">): boolean {
  return job.status !== "fired" && job.status !== "cancelled";
}

/**
 * Presentation-layer one-shot flag. A COUNT=1 rrule fires exactly once and
 * should read as one-time in clients, even though the scheduler internally
 * treats expression-backed jobs as recurring (retry policy, conversation
 * reuse). Do not feed this back into scheduler logic.
 */
function isOneShotForDisplay(
  job: Pick<ScheduleJob, "syntax" | "cronExpression">,
): boolean {
  if (job.cronExpression == null) {
    return true;
  }
  return job.syntax === "rrule" && isSingleFireRRule(job.cronExpression);
}

function serializeSchedule(
  j: ScheduleJob,
  sourceConversationCache: Map<string, CreatedFromConversationState>,
) {
  const sourceConversation = getCreatedFromConversationState(
    j.createdFromConversationId,
    sourceConversationCache,
  );
  return {
    id: j.id,
    name: j.name,
    enabled: j.enabled,
    syntax: j.syntax,
    expression: j.expression,
    cronExpression: j.cronExpression,
    timezone: j.timezone,
    message: j.message,
    script: j.script,
    nextRunAt: j.nextRunAt,
    lastRunAt: j.lastRunAt,
    lastStatus: j.lastStatus,
    retryCount: j.retryCount,
    maxRetries: j.maxRetries,
    retryBackoffMs: j.retryBackoffMs,
    timeoutMs: j.timeoutMs,
    inferenceProfile: j.inferenceProfile,
    groupId: j.groupId,
    createdFromConversationId: j.createdFromConversationId,
    createdFromConversationExists: sourceConversation.exists,
    createdFromConversationArchivedAt: sourceConversation.archivedAt,
    description: j.description,
    cadenceDescription: getCadenceDescription(j),
    mode: j.mode,
    status: j.status,
    routingIntent: j.routingIntent,
    reuseConversation: j.reuseConversation,
    wakeConversationId: j.wakeConversationId,
    workflowName: j.workflowName,
    sourceKey: j.sourceKey,
    userEnabled: j.userEnabled,
    isOneShot: isOneShotForDisplay(j),
    isDeferred: isDeferSchedule(j.createdBy),
  };
}

function handleListSchedules(queryParams: Record<string, string>) {
  const includeAll = queryParams.include_all === "true";
  const inferenceProfile = queryParams.inference_profile?.trim();
  const jobs = listSchedules(
    inferenceProfile ? { inferenceProfile } : undefined,
  );
  const filtered = includeAll
    ? jobs
    : jobs.filter((j) => !isDeferSchedule(j.createdBy));
  const sourceConversationCache = new Map<
    string,
    CreatedFromConversationState
  >();
  return {
    schedules: filtered.map((j) =>
      serializeSchedule(j, sourceConversationCache),
    ),
  };
}

function handleGetSchedule(id: string) {
  const job = getSchedule(id);
  if (!job) {
    throw new NotFoundError("Schedule not found");
  }
  return { schedule: serializeSchedule(job, new Map()) };
}

/**
 * Move schedules onto the `to` inference profile.
 *
 * `from` narrows the move to the schedules pinned to that profile. It is the
 * companion to deleting an inference profile: without it the profile's
 * schedules keep a pin that no longer names anything. The dangling pin is not
 * fatal (the resolver drops a missing override and falls through to the call
 * site's own selection), so this exists to keep the user's stated model choice
 * rather than to prevent a failure.
 *
 * Omitting `from` selects every schedule that can still run, which is what
 * re-pinning the whole set onto the current default needs: schedules pinned by
 * earlier defaults name several different profiles, so there is no single
 * source to move from. A one-shot that already fired and a cancelled row are
 * left out: their profile is history, and rewriting them would report a move
 * larger than the set the user was looking at. An explicit `from` still
 * selects exactly the rows pinned to it, dead or not, since a deleted profile
 * has to be swept out of every row that names it. Rows already pinned to `to`
 * are skipped either way, so the returned count is the number of schedules
 * whose model actually changed.
 *
 * Each row goes through `updateSchedule`, so the store's profile validation
 * and re-snapshot semantics apply exactly as they do to a single-row PATCH.
 * Deferred-wake rows are moved too, since a defer inherits the profile of the
 * conversation it was created in and would otherwise be the one row left
 * dangling. Callers that warn a user before deleting a profile must count
 * those rows as well, which is what `include_all` plus the serialized
 * `isDeferred` flag on the list route are for. Moving one is a guardian-owned
 * state change, so the whole call requires owner authority as soon as a wake
 * row is in the selected set.
 */
async function handleReassignScheduleInferenceProfile(
  body: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  const hasFrom = body.from !== undefined && body.from !== null;
  const from = typeof body.from === "string" ? body.from.trim() : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (hasFrom && !from) {
    throw new BadRequestError(
      "from must name an inference profile when provided",
    );
  }
  if (!to) {
    throw new BadRequestError("to is required");
  }
  // `to` must name a configured profile; `from` deliberately is not validated
  // so an already-deleted profile's leftover pins can still be swept up.
  const profileError = validateScheduleInferenceProfile(to);
  if (profileError) {
    throw new BadRequestError(profileError);
  }

  const selected = hasFrom
    ? listSchedules({ inferenceProfile: from })
    : listSchedules().filter(canScheduleStillRun);
  const matches = selected.filter((job) => job.inferenceProfile !== to);
  // The guard depends only on the caller, so its answer is the same for every
  // row: settle it once for the whole set. Checking per row would spend a
  // cache-bypassing gateway round trip per matching reminder, and a profile
  // that many reminders point at would take seconds to move or time out.
  // All-or-nothing either way: one wake row in scope refuses the whole call
  // before anything moves.
  const wakeMatch = matches.find((job) => job.mode === "wake") ?? null;
  await assertWakeMutationAllowed(wakeMatch, undefined, headers);

  let reassigned = 0;
  for (const job of matches) {
    const updated = await updateSchedule(job.id, { inferenceProfile: to });
    if (updated) {
      reassigned += 1;
    }
  }
  if (reassigned > 0) {
    log.info(
      { from: hasFrom ? from : null, to, reassigned },
      "Schedules reassigned to new profile",
    );
  }
  return { reassigned };
}

async function handleCreateSchedule(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const expression =
    typeof body.expression === "string" ? body.expression.trim() : "";
  const description =
    body.description === undefined
      ? undefined
      : typeof body.description === "string"
        ? body.description.trim()
        : "";
  const message = typeof body.message === "string" ? body.message : "";
  const timezoneRaw =
    typeof body.timezone === "string" ? body.timezone.trim() : "";
  const timezone = timezoneRaw === "" ? null : timezoneRaw;
  const enabled = body.enabled !== false;
  const mode = (body.mode as string | undefined) ?? "execute";
  const inferenceProfile =
    body.inferenceProfile == null ? null : body.inferenceProfile;

  if (inferenceProfile !== null) {
    if (typeof inferenceProfile !== "string") {
      throw new BadRequestError("inferenceProfile must be a string or null");
    }
    const profileError = validateScheduleInferenceProfile(inferenceProfile);
    if (profileError) {
      throw new BadRequestError(profileError);
    }
  }

  if (!name) {
    throw new BadRequestError("name is required");
  }
  if (!expression) {
    throw new BadRequestError("expression is required");
  }
  // Workflow-mode runs trigger a saved workflow by name and ignore `job.message`
  // entirely (see the workflow branch below), so only require a message for the
  // execute path. Requiring it for workflow mode would force API/UI callers to
  // pass an unused dummy string.
  if (mode !== "workflow" && mode !== "script" && !message) {
    throw new BadRequestError("message is required");
  }
  if (description === "") {
    throw new BadRequestError("description is required");
  }

  // The settings UI only exposes execute mode; `workflow` mode is reachable
  // here (flag-gated) and via the schedule_create LLM tool. All other modes
  // remain tool-only.
  if (mode !== "execute" && mode !== "workflow" && mode !== "script") {
    throw new BadRequestError(
      "Only 'execute', 'script', and 'workflow' modes are supported by this endpoint",
    );
  }

  const normalized = normalizeScheduleSyntax({ expression });
  if (!normalized) {
    throw new BadRequestError(
      "expression could not be parsed as cron or rrule",
    );
  }

  if (mode === "workflow") {
    const workflowName =
      typeof body.workflowName === "string" ? body.workflowName.trim() : "";
    if (!workflowName) {
      throw new BadRequestError(
        "workflowName is required for workflow-mode schedules",
      );
    }
    try {
      const job = await createSchedule({
        name,
        description,
        message,
        mode: "workflow",
        workflowName,
        workflowArgs: body.workflowArgs,
        enabled,
        timezone,
        expression: normalized.expression,
        syntax: normalized.syntax,
        inferenceProfile,
      });
      log.info(
        { id: job.id, name: job.name, workflowName },
        "Workflow schedule created",
      );
      return { schedule: serializeSchedule(job, new Map()) };
    } catch (err) {
      if (err instanceof Error) {
        throw new BadRequestError(err.message);
      }
      throw err;
    }
  }

  if (mode === "script") {
    const script = typeof body.script === "string" ? body.script.trim() : "";
    if (!script) {
      throw new BadRequestError("script is required for script-mode schedules");
    }
    const timeoutMs = body.timeoutMs == null ? null : Number(body.timeoutMs);
    if (timeoutMs !== null) {
      const timeoutError = validateScriptTimeoutMs(timeoutMs);
      if (timeoutError) {
        throw new BadRequestError(timeoutError);
      }
    }
    try {
      const job = await createSchedule({
        name,
        description,
        message,
        mode: "script",
        script,
        enabled,
        timezone,
        expression: normalized.expression,
        syntax: normalized.syntax,
        timeoutMs,
        inferenceProfile,
      });
      log.info({ id: job.id, name: job.name }, "Script schedule created");
      return { schedule: serializeSchedule(job, new Map()) };
    } catch (err) {
      if (err instanceof Error) {
        throw new BadRequestError(err.message);
      }
      throw err;
    }
  }

  try {
    const job = await createSchedule({
      name,
      description,
      message,
      mode: "execute",
      enabled,
      timezone,
      expression: normalized.expression,
      syntax: normalized.syntax,
      inferenceProfile,
    });
    log.info({ id: job.id, name: job.name }, "Schedule created");
    return { schedule: serializeSchedule(job, new Map()) };
  } catch (err) {
    if (err instanceof Error) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }
}

async function handleToggleSchedule(
  id: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  const enabled = body.enabled;
  if (typeof enabled !== "boolean") {
    throw new BadRequestError("enabled is required");
  }

  // Enabling is a firing trigger in its own right: a disabled wake row whose
  // `nextRunAt` has already passed fires on the next tick the moment it is
  // enabled, with no further caller involvement.
  await assertWakeMutationAllowed(getSchedule(id), undefined, headers);

  // One endpoint serves both kinds of row: imperative schedules take the
  // plain enabled write, plugin-sourced ones record the user_enabled override.
  const updated = await setUserEnabled(id, enabled);
  if (!updated) {
    throw new NotFoundError("Schedule not found");
  }
  log.info({ id, enabled }, "Schedule toggled");
  return handleListSchedules({});
}

async function handleDeleteSchedule(
  id: string,
  headers?: Record<string, string>,
) {
  await assertWakeMutationAllowed(getSchedule(id), undefined, headers);
  let removed: boolean;
  try {
    removed = await deleteSchedule(id);
  } catch (err) {
    // Store-layer refusals (e.g. plugin-sourced rows, which only the plugin's
    // schedule file can remove) are caller mistakes with an actionable
    // message, not daemon faults.
    if (err instanceof UserError) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }
  if (!removed) {
    throw new NotFoundError("Schedule not found");
  }
  log.info({ id }, "Schedule removed");
  return handleListSchedules({});
}

async function handleCancelSchedule(
  id: string,
  headers?: Record<string, string>,
) {
  await assertWakeMutationAllowed(getSchedule(id), undefined, headers);
  let cancelled: boolean;
  try {
    cancelled = await cancelSchedule(id);
  } catch (err) {
    // Store-layer refusals (plugin-sourced rows, for which cancellation is a
    // permanent latch) are caller mistakes with an actionable message, not
    // daemon faults.
    if (err instanceof UserError) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }
  if (!cancelled) {
    throw new NotFoundError("Schedule not found or not cancellable");
  }
  log.info({ id }, "Schedule cancelled");
  return handleListSchedules({});
}

const VALID_MODES = [
  "notify",
  "execute",
  "script",
  "wake",
  "workflow",
] as const;
const VALID_ROUTING_INTENTS = [
  "single_channel",
  "multi_channel",
  "all_channels",
] as const;

async function handleUpdateSchedule(
  id: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  if (
    "mode" in body &&
    !VALID_MODES.includes(body.mode as (typeof VALID_MODES)[number])
  ) {
    throw new BadRequestError(
      `Invalid mode: must be one of ${VALID_MODES.join(", ")}`,
    );
  }
  if (
    "routingIntent" in body &&
    !VALID_ROUTING_INTENTS.includes(
      body.routingIntent as (typeof VALID_ROUTING_INTENTS)[number],
    )
  ) {
    throw new BadRequestError(
      `Invalid routingIntent: must be one of ${VALID_ROUTING_INTENTS.join(", ")}`,
    );
  }

  // Mirror the create-side validation: a schedule whose RESULTING mode is
  // `workflow` must carry a non-empty `workflowName`. Without this, a PATCH can
  // leave a workflow-mode schedule nameless — the scheduler then hits the
  // `!job.workflowName` skip branch and a one-shot job claimed as `firing`
  // never calls completeOneShot/retry, wedging it `firing` forever. We compute
  // the post-update state (the body's value if present, else the persisted one)
  // so both "switch to workflow without a name" and "clear the name on an
  // already-workflow schedule" are rejected. Skip when the schedule does not
  // exist — the updateSchedule call below surfaces that as NotFound.
  const existing = getSchedule(id);
  if (existing) {
    const resultingMode =
      "mode" in body ? (body.mode as string) : existing.mode;
    await assertWakeMutationAllowed(existing, resultingMode, headers);
    if (resultingMode === "workflow") {
      const resultingWorkflowName =
        "workflowName" in body
          ? typeof body.workflowName === "string"
            ? body.workflowName.trim()
            : ""
          : (existing.workflowName ?? "");
      if (!resultingWorkflowName) {
        throw new BadRequestError(
          "workflowName is required for workflow-mode schedules",
        );
      }
    }
  }

  const updates: Record<string, unknown> = {};
  for (const key of [
    "name",
    "expression",
    "timezone",
    "message",
    "script",
    "mode",
    "routingIntent",
    "quiet",
    "reuseConversation",
    "wakeConversationId",
    "workflowName",
    "workflowArgs",
    "maxRetries",
    "retryBackoffMs",
    "timeoutMs",
  ] as const) {
    if (key in body) {
      updates[key] = body[key];
    }
  }

  // Re-derive syntax whenever the expression changes, mirroring the create
  // handler. Without this, switching an expression between cron and rrule
  // would validate the new expression against the schedule's old syntax.
  if (typeof updates.expression === "string") {
    const normalized = normalizeScheduleSyntax({
      expression: updates.expression,
    });
    if (!normalized) {
      throw new BadRequestError(
        "expression could not be parsed as cron or rrule",
      );
    }
    updates.syntax = normalized.syntax;
  }

  if ("description" in body) {
    const description =
      typeof body.description === "string" ? body.description.trim() : "";
    if (!description) {
      throw new BadRequestError("description is required");
    }
    updates.description = description;
  }

  if (updates.timeoutMs != null) {
    if (typeof updates.timeoutMs !== "number") {
      throw new BadRequestError("timeoutMs must be a number or null");
    }
    const timeoutError = validateScriptTimeoutMs(updates.timeoutMs);
    if (timeoutError) {
      throw new BadRequestError(timeoutError);
    }
  }

  // Inference profile: null re-pins to the currently resolved default; a
  // string must name a configured profile.
  if ("inferenceProfile" in body) {
    const inferenceProfile = body.inferenceProfile;
    if (inferenceProfile !== null && typeof inferenceProfile !== "string") {
      throw new BadRequestError("inferenceProfile must be a string or null");
    }
    if (typeof inferenceProfile === "string") {
      const profileError = validateScheduleInferenceProfile(inferenceProfile);
      if (profileError) {
        throw new BadRequestError(profileError);
      }
    }
    updates.inferenceProfile = inferenceProfile;
  }

  try {
    const updated = await updateSchedule(id, updates);
    if (!updated) {
      throw new NotFoundError("Schedule not found");
    }
    log.info({ id, updates }, "Schedule updated");
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof BadRequestError) {
      throw err;
    }
    // Store-layer refusals (e.g. the trusted-defer immutable-field refusal)
    // are caller mistakes with an actionable message, not daemon faults.
    if (err instanceof UserError) {
      throw new BadRequestError(err.message);
    }
    if (
      err instanceof Error &&
      (err.message.includes("Invalid") || err.message.includes("invalid"))
    ) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }
  return handleListSchedules({});
}

function handleListScheduleRuns(
  id: string,
  queryParams: Record<string, string>,
) {
  const schedule = getSchedule(id);
  if (!schedule) {
    throw new NotFoundError("Schedule not found");
  }
  const limit = parseRunsLimit(queryParams, 10);
  const before = parseRunsBeforeCursor(queryParams);
  const { rows, nextCursor } = paginateRuns(
    getScheduleRuns(id, limit + 1, before),
    limit,
    (r) => r.createdAt,
  );
  const now = Date.now();
  return {
    nextCursor,
    runs: rows.map((r) => {
      const conversation = r.conversationId
        ? getConversation(r.conversationId)
        : null;
      // The usage ledger supplies every conversation stamped with this run's
      // cron_run_id. The legacy single pointer is added on top, which covers
      // runs whose usage predates cron_run_id stamping. The synthetic
      // "script:<jobId>" sentinel never resolves to a conversation, so it
      // drops out here on its own.
      const runConversationIds = new Set(listRunConversationIds(r.id));
      if (r.conversationId && conversation) {
        runConversationIds.add(r.conversationId);
      }
      const conversations = [...runConversationIds].map((cid) => {
        const c =
          cid === r.conversationId ? conversation : getConversation(cid);
        return {
          id: cid,
          title: c?.title ?? null,
          exists: c != null,
          archivedAt: c?.archivedAt ?? null,
        };
      });
      return {
        id: r.id,
        jobId: r.jobId,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs: r.durationMs,
        output: r.output,
        error: r.error,
        conversationId: r.conversationId,
        conversationExists: conversation != null,
        conversationArchivedAt: conversation?.archivedAt ?? null,
        conversations,
        estimatedCostUsd: getUsageCostForRun({
          cronRunId: r.id,
          conversationId: r.conversationId ?? undefined,
          from: r.startedAt,
          to: r.finishedAt ?? now,
        }),
        createdAt: r.createdAt,
      };
    }),
  };
}

function handleScheduleUsageSummary(queryParams: Record<string, string>) {
  const range = parseEpochMillisRange(queryParams);
  return { summaries: getScheduleUsageSummaries(range) };
}

// ---------------------------------------------------------------------------
// Shared route definitions (HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listSchedules",
    endpoint: "schedules",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List schedules",
    description: "Return all scheduled jobs.",
    tags: ["schedules"],
    queryParams: [
      {
        name: "include_all",
        schema: { type: "string" },
        description:
          "When 'true', include deferred schedules that are normally hidden.",
      },
      {
        name: "inference_profile",
        schema: { type: "string" },
        description:
          "Return only schedules pinned to this inference profile (llm.profiles key).",
      },
    ],
    responseBody: z.object({
      schedules: z.array(scheduleSchema).describe("Schedule objects"),
    }),
    handler: ({ queryParams }: RouteHandlerArgs) =>
      handleListSchedules(queryParams ?? {}),
  },
  {
    operationId: "getScheduleUsageSummary",
    endpoint: "schedules/usage-summary",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get schedule usage summaries",
    description:
      "Return per-schedule run counts and usage totals for a time range.",
    tags: ["schedules"],
    queryParams: [
      {
        name: "from",
        type: "integer",
        required: true,
        description: "Start epoch millis (required)",
      },
      {
        name: "to",
        type: "integer",
        required: true,
        description: "End epoch millis (required)",
      },
    ],
    responseBody: z.object({
      summaries: z
        .array(scheduleUsageSummarySchema)
        .describe("Schedule usage summary rows"),
    }),
    handler: ({ queryParams }: RouteHandlerArgs) =>
      handleScheduleUsageSummary(queryParams ?? {}),
  },
  {
    operationId: "reassignScheduleInferenceProfile",
    endpoint: "schedules/reassign-profile",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Reassign schedules to another inference profile",
    description:
      "Move schedules onto one inference profile. Pass 'from' to move only the schedules pinned to that profile, so deleting a profile does not leave its schedules pointing at a name that no longer exists. Omit 'from' to move every schedule, which re-pins the whole set onto one profile. Schedules already pinned to the target are skipped.",
    tags: ["schedules"],
    requestBody: z.object({
      from: z
        .string()
        .optional()
        .describe(
          "Inference profile key the schedules are pinned to now; omit to select every schedule",
        ),
      to: z
        .string()
        .describe("Inference profile key to move them to; must be configured"),
    }),
    responseBody: z.object({
      reassigned: z.number().describe("Number of schedules moved"),
    }),
    handler: ({ body, headers }: RouteHandlerArgs) =>
      handleReassignScheduleInferenceProfile(body ?? {}, headers),
  },
  // Must stay after literal `schedules/*` siblings (e.g. usage-summary,
  // reassign-profile): the router matches in declaration order and `:id`
  // would shadow them.
  {
    operationId: "getSchedule",
    endpoint: "schedules/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get schedule",
    description: "Return a single schedule by ID.",
    tags: ["schedules"],
    responseBody: z.object({
      schedule: scheduleSchema.describe("Schedule object"),
    }),
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleGetSchedule(pathParams!.id),
  },
  {
    operationId: "createSchedule",
    endpoint: "schedules",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create schedule",
    description:
      "Create a new recurring schedule (execute, script, or workflow mode).",
    tags: ["schedules"],
    requestBody: z.object({
      name: z.string().describe("Display name"),
      description: z
        .string()
        .describe(
          "Authored schedule description. Defaults to the schedule name when omitted for backward compatibility.",
        )
        .optional(),
      expression: z.string().describe("Cron or RRULE expression"),
      message: z
        .string()
        .describe(
          "Message body to execute on each fire. Required for execute mode; ignored for workflow mode (which triggers workflowName/workflowArgs).",
        )
        .optional(),
      timezone: z
        .string()
        .nullable()
        .describe("IANA timezone, e.g. America/New_York")
        .optional(),
      enabled: z
        .boolean()
        .describe("Whether the schedule starts active (default true)")
        .optional(),
      mode: z
        .string()
        .describe("'execute' (default), 'script', or 'workflow' (flag-gated)")
        .optional(),
      workflowName: z
        .string()
        .describe("Saved workflow to trigger (required for workflow mode)")
        .optional(),
      workflowArgs: z
        .unknown()
        .describe("Args passed to the workflow run (workflow mode)")
        .optional(),
      script: z
        .string()
        .describe("Shell command run on each fire (required for script mode)")
        .optional(),
      timeoutMs: z
        .number()
        .nullable()
        .describe("Script execution timeout override in ms (script mode)")
        .optional(),
      inferenceProfile: z
        .string()
        .nullable()
        .describe(
          "Inference profile (llm.profiles key) the schedule's runs use. Omitted or null pins the schedule to the currently resolved default profile, so its model does not move when that default changes. Workflow-mode schedules resolve a model per workflow step, so the pin is recorded but does not govern their runs.",
        )
        .optional(),
    }),
    responseBody: z.object({
      schedule: scheduleSchema.describe("The created schedule"),
    }),
    handler: ({ body }: RouteHandlerArgs) => handleCreateSchedule(body ?? {}),
  },
  {
    operationId: "listScheduleRuns",
    endpoint: "schedules/:id/runs",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List schedule runs",
    description: "Return recent invocation history for a schedule.",
    tags: ["schedules"],
    queryParams: RUNS_PAGINATION_QUERY_PARAMS(10),
    responseBody: z.object({
      runs: z.array(scheduleRunSchema).describe("Schedule run objects"),
      nextCursor: RUNS_NEXT_CURSOR_SCHEMA,
    }),
    handler: ({ pathParams, queryParams }: RouteHandlerArgs) =>
      handleListScheduleRuns(pathParams!.id, queryParams ?? {}),
  },
  {
    operationId: "toggleSchedule",
    endpoint: "schedules/:id/toggle",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Toggle schedule",
    description:
      "Enable or disable a schedule. On a plugin-managed schedule this records the user's override (userEnabled).",
    tags: ["schedules"],
    requestBody: z.object({
      enabled: z.boolean().describe("New enabled state"),
    }),
    responseBody: z.object({
      schedules: z.array(scheduleSchema).describe("Updated schedule list"),
    }),
    handler: ({ pathParams, body, headers }: RouteHandlerArgs) =>
      handleToggleSchedule(pathParams!.id, body ?? {}, headers),
  },
  {
    operationId: "deleteSchedule",
    endpoint: "schedules/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete schedule",
    description: "Remove a schedule by ID.",
    tags: ["schedules"],
    responseBody: z.object({
      schedules: z.array(scheduleSchema).describe("Updated schedule list"),
    }),
    handler: ({ pathParams, headers }: RouteHandlerArgs) =>
      handleDeleteSchedule(pathParams!.id, headers),
  },
  {
    operationId: "updateSchedule",
    endpoint: "schedules/:id",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update schedule",
    description: "Partially update fields on a schedule.",
    tags: ["schedules"],
    requestBody: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      expression: z.string().optional(),
      timezone: z.string().optional(),
      message: z.string().optional(),
      script: z
        .string()
        .nullable()
        .describe("Shell command for script mode")
        .optional(),
      mode: z
        .string()
        .describe("notify, execute, script, wake, or workflow")
        .optional(),
      workflowName: z
        .string()
        .nullable()
        .describe("Saved workflow to trigger (workflow mode)")
        .optional(),
      workflowArgs: z
        .unknown()
        .describe("Args passed to the workflow run (workflow mode)")
        .optional(),
      routingIntent: z
        .string()
        .describe("single_channel, multi_channel, or all_channels")
        .optional(),
      quiet: z.boolean().optional(),
      reuseConversation: z.boolean().optional(),
      maxRetries: z.number().describe("Maximum retry attempts").optional(),
      retryBackoffMs: z
        .number()
        .describe("Retry backoff in milliseconds")
        .optional(),
      timeoutMs: z
        .number()
        .nullable()
        .describe("Script-mode execution timeout in ms; null = use default")
        .optional(),
      inferenceProfile: z
        .string()
        .nullable()
        .describe(
          "Inference profile (llm.profiles key) the schedule's runs use; null re-pins the schedule to the currently resolved default profile. Workflow-mode schedules resolve a model per workflow step, so the pin is recorded but does not govern their runs.",
        )
        .optional(),
    }),
    responseBody: z.object({
      schedules: z.array(scheduleSchema).describe("Updated schedule list"),
    }),
    handler: ({ pathParams, body, headers }: RouteHandlerArgs) =>
      handleUpdateSchedule(pathParams!.id, body ?? {}, headers),
  },
  {
    operationId: "cancelSchedule",
    endpoint: "schedules/:id/cancel",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Cancel schedule",
    description: "Cancel a pending schedule.",
    tags: ["schedules"],
    responseBody: z.object({
      schedules: z.array(scheduleSchema).describe("Updated schedule list"),
    }),
    handler: ({ pathParams, headers }: RouteHandlerArgs) =>
      handleCancelSchedule(pathParams!.id, headers),
  },
  {
    operationId: "runScheduleNow",
    endpoint: "schedules/:id/run",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Run schedule now",
    description:
      "Trigger an immediate execution of a schedule. A plugin-sourced schedule is rejected with a 400 when its plugin is disabled or no longer declares it.",
    tags: ["schedules"],
    responseBody: z.object({
      schedules: z.array(scheduleSchema).describe("Updated schedule list"),
    }),
    handler: ({ pathParams, headers }: RouteHandlerArgs) =>
      handleRunScheduleNow(pathParams!.id, headers),
  },
];

async function handleRunScheduleNow(
  id: string,
  headers?: Record<string, string>,
) {
  const schedule = getSchedule(id);
  if (!schedule) {
    throw new NotFoundError("Schedule not found");
  }

  // A plugin-sourced row runs the plugin's own script or prompt, so run-now is
  // only offered while that plugin is something the runtime would activate.
  // `declarationExistsOnDisk` is the same probe the enable path uses: it covers
  // a disabled plugin, an unreadable or invalid manifest, and a declaration
  // that is simply gone. Turning the feature flag off retires the surface
  // wholesale and takes the same path. The row can still be armed at this
  // point, because the reconciler that disarms it runs on its own schedule.
  if (
    schedule.sourceKey !== null &&
    (!isPluginSchedulesEnabled() ||
      !(await declarationExistsOnDisk(schedule.sourceKey)))
  ) {
    throw new BadRequestError(
      "This schedule's plugin is disabled or no longer declares it, so it cannot be run.",
    );
  }

  // ── Script mode (shell command, no LLM) ──────────────────────────
  if (schedule.mode === "script") {
    if (!schedule.script) {
      throw new BadRequestError("Script schedule has no script command");
    }
    const runId = await createScheduleRun(schedule.id, `script:${schedule.id}`);
    try {
      log.info(
        { jobId: schedule.id, name: schedule.name },
        "Executing script schedule manually (run now)",
      );
      const result = await runScript(schedule.script, {
        timeoutMs: schedule.timeoutMs ?? undefined,
        scheduleRunId: runId,
        scheduleId: schedule.id,
      });
      await completeScheduleRun(runId, {
        status: result.exitCode === 0 ? "ok" : "error",
        output: result.stdout || undefined,
        error: result.stderr || undefined,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, jobId: schedule.id, name: schedule.name },
        "Manual script schedule execution failed",
      );
      await completeScheduleRun(runId, { status: "error", error: errorMsg });
    }
    return handleListSchedules({});
  }

  // ── Workflow mode (trigger a saved workflow by name) ──────────────
  // Mirrors the scheduler's automatic workflow-firing branch. Without this, a
  // workflow-mode schedule manually triggered via `POST /schedules/:id/run`
  // would fall through to the regular message path below and process
  // `schedule.message` (usually empty — workflow-mode create no longer requires
  // a message), running a no-op normal turn instead of the workflow.
  if (schedule.mode === "workflow") {
    if (!schedule.workflowName) {
      throw new BadRequestError("Workflow schedule has no workflowName");
    }
    // resolveCapabilities grants the read-only baseline (file_read, web_search,
    // …) from the tool registry, so the baseline must be registered before the
    // run launches or it would get an empty toolset. Ensure it — idempotent and
    // cached, so this is a settled-promise await except in the few-seconds boot
    // window, where it blocks until the registry is populated.
    await initializeTools();
    const runId = await createScheduleRun(
      schedule.id,
      `workflow:${schedule.id}`,
    );
    try {
      log.info(
        {
          jobId: schedule.id,
          name: schedule.name,
          workflowName: schedule.workflowName,
        },
        "Triggering workflow schedule manually (run now)",
      );
      const { runId: workflowRunId } = getWorkflowRunManager().start({
        name: schedule.workflowName,
        args: schedule.workflowArgs ?? {},
        // Deliver the completion summary to the schedule's wake target, falling
        // back to the conversation that created it (workflow schedules made via
        // `schedule_create` store `createdFromConversationId` and leave
        // `wakeConversationId` unset) — mirrors the scheduler's firing path.
        conversationId:
          schedule.wakeConversationId ??
          schedule.createdFromConversationId ??
          undefined,
        // The schedule's persisted capability manifest scopes the run, mirroring
        // the scheduler's firing path; a legacy schedule with null
        // `capabilities` normalizes to the read-only baseline.
        manifest: normalizeCapabilityManifest(schedule.capabilities),
        trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
      });
      // `start` launches the run fire-and-forget and returns synchronously;
      // a successful trigger is recorded as ok. Completion/failure is surfaced
      // out-of-band via workflow events and the completion wake.
      await completeScheduleRun(runId, {
        status: "ok",
        output: `workflow run ${workflowRunId} started`,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, jobId: schedule.id, name: schedule.name },
        "Manual workflow schedule execution failed",
      );
      await completeScheduleRun(runId, { status: "error", error: errorMsg });
    }
    return handleListSchedules({});
  }

  // Legacy task-template schedules (message `run_task:<id>`) reference a
  // capability that has been removed. Record a failed run instead of forwarding
  // the raw `run_task:<id>` string to the agent.
  if (/^run_task:\S+$/.test(schedule.message)) {
    const runId = await createScheduleRun(schedule.id, null);
    await completeScheduleRun(runId, {
      status: "error",
      error: "Scheduled task templates are no longer supported.",
    });
    log.warn(
      { jobId: schedule.id, name: schedule.name },
      "Skipped unsupported task-template schedule (run_task, manual run-now)",
    );
    return handleListSchedules({});
  }

  // ── Wake mode (resume an existing conversation, no new message) ────
  if (schedule.mode === "wake") {
    // Refuse before invoking anything. Firing early is not a lesser act than
    // editing: it runs a turn in the target conversation on demand, which
    // pollutes the transcript and spends inference even when no trust is
    // recovered. Denying it also suppresses nothing, since the autonomous tick
    // still fires the deferral at its scheduled time.
    await assertWakeMutationAllowed(schedule, undefined, headers);
    if (!schedule.wakeConversationId) {
      throw new BadRequestError("Wake schedule has no target conversation");
    }
    const { wakeAgentForOpportunity } = await import("../agent-wake.js");
    try {
      await wakeAgentForOpportunity(
        buildWakeScheduleOptions(schedule, schedule.wakeConversationId),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, jobId: schedule.id }, "Manual wake execution failed");
      throw new InternalError(message);
    }
    return handleListSchedules({});
  }

  // Regular message-based schedule — respect reuseConversation flag
  const isRecurring = schedule.expression != null;
  let conversationId: string | null = null;
  if (schedule.reuseConversation && isRecurring) {
    const lastId = getLastScheduleConversationId(schedule.id);
    if (lastId && getConversation(lastId)) {
      conversationId = lastId;
    }
  }
  if (!conversationId) {
    const conversation = await bootstrapConversation({
      source: "schedule",
      groupId: resolveScheduleConversationGroupId(schedule),
      origin: "schedule",
      systemHint: `Schedule (manual): ${schedule.name}`,
    });
    conversationId = conversation.id;
  }
  const runId = await createScheduleRun(schedule.id, conversationId);

  try {
    log.info(
      {
        jobId: schedule.id,
        name: schedule.name,
        conversationId,
      },
      "Executing schedule manually (run now)",
    );
    const activeConversation = await getOrCreateConversation(conversationId, {
      trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
    });
    activeConversation.taskRunId = undefined;
    await activeConversation.processMessage({
      content: schedule.message,
      attachments: [],
      onEvent: () => {},
      isInteractive: false,
      ...(schedule.inferenceProfile
        ? { overrideProfile: schedule.inferenceProfile }
        : {}),
    });
    await completeScheduleRun(runId, { status: "ok" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { err, jobId: schedule.id, name: schedule.name },
      "Manual schedule execution failed",
    );
    await completeScheduleRun(runId, { status: "error", error: message });
  }
  return handleListSchedules({});
}
