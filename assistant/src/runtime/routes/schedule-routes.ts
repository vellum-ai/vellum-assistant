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
import { validateScheduleInferenceProfile } from "../../schedule/inference-profile.js";
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
  type ScheduleJob,
  setScheduleRunConversationId,
  updateSchedule,
} from "../../schedule/schedule-store.js";
import { getScheduleUsageSummaries } from "../../schedule/schedule-usage-store.js";
import { areCoreToolsInitialized } from "../../tools/registry.js";
import { getLogger } from "../../util/logger.js";
import { normalizeCapabilityManifest } from "../../workflows/capabilities.js";
import { getWorkflowRunManager } from "../../workflows/run-manager.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { parseEpochMillisRange } from "./epoch-millis-range.js";
import {
  BadRequestError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
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
  isOneShot: z.boolean(),
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
  if (cached) return cached;

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
 * Presentation-layer one-shot flag. A COUNT=1 rrule fires exactly once and
 * should read as one-time in clients, even though the scheduler internally
 * treats expression-backed jobs as recurring (retry policy, conversation
 * reuse). Do not feed this back into scheduler logic.
 */
function isOneShotForDisplay(
  job: Pick<ScheduleJob, "syntax" | "cronExpression">,
): boolean {
  if (job.cronExpression == null) return true;
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
    isOneShot: isOneShotForDisplay(j),
  };
}

function handleListSchedules(queryParams: Record<string, string>) {
  const includeAll = queryParams.include_all === "true";
  const jobs = listSchedules();
  const filtered = includeAll
    ? jobs
    : jobs.filter((j) => j.createdBy !== "defer");
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
    if (profileError) throw new BadRequestError(profileError);
  }

  if (!name) throw new BadRequestError("name is required");
  if (!expression) throw new BadRequestError("expression is required");
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
      });
      log.info(
        { id: job.id, name: job.name, workflowName },
        "Workflow schedule created",
      );
      return { schedule: serializeSchedule(job, new Map()) };
    } catch (err) {
      if (err instanceof Error) throw new BadRequestError(err.message);
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
      if (timeoutError) throw new BadRequestError(timeoutError);
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
      });
      log.info({ id: job.id, name: job.name }, "Script schedule created");
      return { schedule: serializeSchedule(job, new Map()) };
    } catch (err) {
      if (err instanceof Error) throw new BadRequestError(err.message);
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
    if (err instanceof Error) throw new BadRequestError(err.message);
    throw err;
  }
}

async function handleToggleSchedule(id: string, body: Record<string, unknown>) {
  const enabled = body.enabled;
  if (typeof enabled !== "boolean") {
    throw new BadRequestError("enabled is required");
  }

  const updated = await updateSchedule(id, { enabled });
  if (!updated) {
    throw new NotFoundError("Schedule not found");
  }
  log.info({ id, enabled }, "Schedule toggled");
  return handleListSchedules({});
}

async function handleDeleteSchedule(id: string) {
  const removed = await deleteSchedule(id);
  if (!removed) {
    throw new NotFoundError("Schedule not found");
  }
  log.info({ id }, "Schedule removed");
  return handleListSchedules({});
}

async function handleCancelSchedule(id: string) {
  const cancelled = await cancelSchedule(id);
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

async function handleUpdateSchedule(id: string, body: Record<string, unknown>) {
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
    if (timeoutError) throw new BadRequestError(timeoutError);
  }

  // Inference profile: null clears the override (back to the default
  // main-agent model selection); a string must name a configured profile.
  if ("inferenceProfile" in body) {
    const inferenceProfile = body.inferenceProfile;
    if (inferenceProfile !== null && typeof inferenceProfile !== "string") {
      throw new BadRequestError("inferenceProfile must be a string or null");
    }
    if (typeof inferenceProfile === "string") {
      const profileError = validateScheduleInferenceProfile(inferenceProfile);
      if (profileError) throw new BadRequestError(profileError);
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
  // Must stay after literal `schedules/*` GET siblings (e.g. usage-summary):
  // the router matches in declaration order and `:id` would shadow them.
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
          "Inference profile (llm.profiles key) the schedule's runs use. Omitted or null = default, i.e. the mainAgent call-site model selection.",
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
    description: "Enable or disable a schedule.",
    tags: ["schedules"],
    requestBody: z.object({
      enabled: z.boolean().describe("New enabled state"),
    }),
    responseBody: z.object({
      schedules: z.array(scheduleSchema).describe("Updated schedule list"),
    }),
    handler: ({ pathParams, body }: RouteHandlerArgs) =>
      handleToggleSchedule(pathParams!.id, body ?? {}),
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
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleDeleteSchedule(pathParams!.id),
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
          "Inference profile (llm.profiles key) the schedule's runs use; null clears it back to the default mainAgent call-site model selection",
        )
        .optional(),
    }),
    responseBody: z.object({
      schedules: z.array(scheduleSchema).describe("Updated schedule list"),
    }),
    handler: ({ pathParams, body }: RouteHandlerArgs) =>
      handleUpdateSchedule(pathParams!.id, body ?? {}),
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
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleCancelSchedule(pathParams!.id),
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
    description: "Trigger an immediate execution of a schedule.",
    tags: ["schedules"],
    responseBody: z.object({
      schedules: z.array(scheduleSchema).describe("Updated schedule list"),
    }),
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleRunScheduleNow(pathParams!.id),
  },
];

async function handleRunScheduleNow(id: string) {
  const schedule = getSchedule(id);
  if (!schedule) {
    throw new NotFoundError("Schedule not found");
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
    // Boot race: resolveCapabilities grants the read-only baseline (file_read,
    // web_search, …) from the tool registry, which initializeProvidersAndTools()
    // populates during startup. The scheduler's automatic firing path DEFERS a
    // workflow trigger to a later tick while `!areCoreToolsInitialized()` so a
    // run never launches with an empty baseline. A manual "run now" has no later
    // tick to defer to, so fail fast with a retryable 503 rather than launch a
    // degraded run; the window is just the few seconds of assistant boot.
    if (!areCoreToolsInitialized()) {
      throw new ServiceUnavailableError(
        "The assistant is still starting up and its tools are not ready yet. " +
          "Try running this workflow again in a moment.",
      );
    }
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

  // Check if message is a task invocation (run_task:<task_id>)
  const taskMatch = schedule.message.match(/^run_task:(\S+)$/);
  if (taskMatch) {
    const taskId = taskMatch[1];
    const runId = await createScheduleRun(schedule.id, null);
    try {
      log.info(
        { jobId: schedule.id, name: schedule.name, taskId },
        "Executing scheduled task manually (run now)",
      );
      const { runTask } = await import("../../tasks/task-runner.js");
      const result = await runTask(
        { taskId, workingDir: process.cwd(), source: "schedule" },
        async (conversationId, message, taskRunId) => {
          const conversation = await getOrCreateConversation(conversationId, {
            trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
          });
          conversation.taskRunId = taskRunId;
          try {
            await conversation.processMessage({
              content: message,
              attachments: [],
              onEvent: () => {},
              isInteractive: false,
              ...(schedule.inferenceProfile
                ? { overrideProfile: schedule.inferenceProfile }
                : {}),
            });
          } finally {
            conversation.taskRunId = undefined;
          }
        },
      );

      await setScheduleRunConversationId(runId, result.conversationId);
      if (result.status === "failed") {
        await completeScheduleRun(runId, {
          status: "error",
          error: result.error ?? "Task run failed",
        });
      } else {
        await completeScheduleRun(runId, { status: "ok" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, jobId: schedule.id, name: schedule.name, taskId },
        "Manual scheduled task execution failed",
      );
      const fallbackConversation = await bootstrapConversation({
        source: "schedule",
        groupId: "system:scheduled",
        origin: "schedule",
        systemHint: `Schedule (manual): ${schedule.name}`,
      });
      await setScheduleRunConversationId(runId, fallbackConversation.id);
      await completeScheduleRun(runId, { status: "error", error: message });
    }
    return handleListSchedules({});
  }

  // ── Wake mode (resume an existing conversation, no new message) ────
  if (schedule.mode === "wake") {
    if (!schedule.wakeConversationId) {
      throw new BadRequestError("Wake schedule has no target conversation");
    }
    const { wakeAgentForOpportunity } = await import("../agent-wake.js");
    try {
      await wakeAgentForOpportunity({
        conversationId: schedule.wakeConversationId,
        hint: schedule.message,
        source: "defer",
        persistTriggerAsEvent: true,
        ...(schedule.inferenceProfile
          ? { forceOverrideProfile: schedule.inferenceProfile }
          : {}),
      });
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
      groupId: "system:scheduled",
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
