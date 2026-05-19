/**
 * Read-only inspection routes for the Autonomous Execution Engine plus
 * confirmed write endpoints for task-companion plans.
 *
 * Plan creation and step transitions are intentionally narrow: they persist
 * user-confirmed goals and visible progress, but do not execute host actions
 * or bypass the existing approval model.
 */

import { z } from "zod";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import type {
  PlanLifecycleMessage,
  PlanStepLifecycleMessage,
} from "../../daemon/message-types/plans.js";
import {
  createPlan,
  getPlanWithSteps,
  listAllPlansForScope,
  listStepRuns,
  markPlanStatus,
  type PlanStepStatus,
  updatePlanStepStatus,
} from "../../plans/plan-store.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const PlanRowSchema = z.object({
  id: z.string(),
  scopeId: z.string(),
  goal: z.string(),
  status: z.string(),
  conversationId: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
});

const PlanStepRowSchema = z.object({
  id: z.string(),
  planId: z.string(),
  stepOrder: z.number(),
  name: z.string(),
  status: z.string(),
  inputJson: z.string(),
  blockedReason: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const PlanStepRunRowSchema = z.object({
  id: z.string(),
  stepId: z.string(),
  attempt: z.number(),
  status: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  errorMessage: z.string().nullable(),
  lifecycleJson: z.string(),
});

const CreatePlanBodySchema = z.object({
  scopeId: z.string().min(1).max(120).optional(),
  goal: z.string().min(1).max(500),
  conversationId: z.string().min(1).max(240).optional(),
  steps: z
    .array(
      z.object({
        name: z.string().min(1).max(240),
        input: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(50),
});

const UpdateStepStatusBodySchema = z.object({
  status: z.enum([
    "pending",
    "running",
    "completed",
    "failed",
    "skipped",
    "blocked",
  ]),
  blockedReason: z.string().min(1).max(500).optional(),
});

function publishEvent(msg: ServerMessage): void {
  void assistantEventHub.publish(buildAssistantEvent(msg));
}

function parseBody<T>(schema: z.ZodType<T>, body: Record<string, unknown>): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues[0]?.message ?? "invalid request body",
    );
  }
  return parsed.data;
}

function emitPlanLifecycle(
  message: Omit<PlanLifecycleMessage, "type" | "ts">,
): void {
  publishEvent({ ...message, type: "plan_lifecycle", ts: Date.now() });
}

function emitStepLifecycle(
  message: Omit<PlanStepLifecycleMessage, "type" | "ts" | "attempt"> & {
    attempt?: number;
  },
): void {
  publishEvent({
    ...message,
    type: "plan_step_lifecycle",
    attempt: message.attempt ?? 0,
    ts: Date.now(),
  });
}

function handleListPlans({ queryParams = {} }: RouteHandlerArgs) {
  const limitRaw = queryParams.limit;
  const limit =
    typeof limitRaw === "string" && limitRaw.length > 0
      ? Number.parseInt(limitRaw, 10)
      : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new BadRequestError("limit must be a positive integer");
  }
  const scopeId = queryParams.scopeId ?? "default";
  return { plans: listAllPlansForScope(scopeId, limit) };
}

function handleGetPlan({ pathParams = {} }: RouteHandlerArgs) {
  const id = pathParams.id;
  if (!id) throw new BadRequestError("plan id is required");
  const found = getPlanWithSteps(id);
  if (!found) throw new NotFoundError(`plan not found: ${id}`);
  const runs: Record<string, ReturnType<typeof listStepRuns>> = {};
  for (const step of found.steps) {
    runs[step.id] = listStepRuns(step.id);
  }
  return { plan: found.plan, steps: found.steps, runs };
}

function handleCreatePlan({ body = {} }: RouteHandlerArgs) {
  const input = parseBody(CreatePlanBodySchema, body);
  const created = createPlan(input);
  emitPlanLifecycle({
    planId: created.plan.id,
    goal: created.plan.goal,
    stage: "started",
    ...(created.plan.conversationId
      ? { conversationId: created.plan.conversationId }
      : {}),
  });
  return { plan: created.plan, steps: created.steps };
}

function handleCancelPlan({ pathParams = {}, body = {} }: RouteHandlerArgs) {
  const id = pathParams.id;
  if (!id) throw new BadRequestError("plan id is required");
  const existing = getPlanWithSteps(id);
  if (!existing) throw new NotFoundError(`plan not found: ${id}`);
  if (
    existing.plan.status === "completed" ||
    existing.plan.status === "failed" ||
    existing.plan.status === "cancelled"
  ) {
    return { plan: existing.plan, cancelled: false };
  }
  const reasonRaw = (body as { reason?: unknown }).reason;
  const reason =
    typeof reasonRaw === "string" && reasonRaw.length > 0
      ? reasonRaw
      : "user_cancel";
  markPlanStatus(id, "cancelled", { cancellationReason: reason });
  const refreshed = getPlanWithSteps(id)!;
  emitPlanLifecycle({
    planId: refreshed.plan.id,
    goal: refreshed.plan.goal,
    stage: "cancelled",
    ...(refreshed.plan.conversationId
      ? { conversationId: refreshed.plan.conversationId }
      : {}),
    message: reason,
  });
  return { plan: refreshed.plan, cancelled: true };
}

function handleUpdateStepStatus({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const planId = pathParams.id;
  const stepId = pathParams.stepId;
  if (!planId) throw new BadRequestError("plan id is required");
  if (!stepId) throw new BadRequestError("step id is required");
  const input = parseBody(UpdateStepStatusBodySchema, body);
  if (input.status === "blocked" && !input.blockedReason) {
    throw new BadRequestError(
      "blockedReason is required when status is blocked",
    );
  }

  let updated;
  try {
    updated = updatePlanStepStatus({
      planId,
      stepId,
      status: input.status as PlanStepStatus,
      ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
    });
  } catch (err) {
    throw new ConflictError(
      err instanceof Error ? err.message : "plan cannot be updated",
    );
  }
  if (!updated) throw new NotFoundError(`plan step not found: ${stepId}`);

  const step = updated.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new NotFoundError(`plan step not found: ${stepId}`);

  const stage =
    input.status === "completed"
      ? "completed"
      : input.status === "blocked"
        ? "blocked"
        : input.status === "failed"
          ? "failed"
          : "executing";
  emitStepLifecycle({
    planId,
    stepId,
    stepOrder: step.stepOrder,
    stepName: step.name,
    stage,
    ...(updated.plan.conversationId
      ? { conversationId: updated.plan.conversationId }
      : {}),
    ...(input.blockedReason ? { message: input.blockedReason } : {}),
  });
  if (updated.plan.status === "completed" || updated.plan.status === "failed") {
    emitPlanLifecycle({
      planId,
      goal: updated.plan.goal,
      stage: updated.plan.status,
      ...(updated.plan.conversationId
        ? { conversationId: updated.plan.conversationId }
        : {}),
    });
  }

  return { plan: updated.plan, steps: updated.steps, step };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "plans_create",
    endpoint: "plans",
    method: "POST",
    handler: handleCreatePlan,
    summary: "Create a confirmed plan",
    description:
      "Persist a user-confirmed multi-step plan without executing any steps.",
    tags: ["plans"],
    requestBody: CreatePlanBodySchema,
    responseBody: z.object({
      plan: PlanRowSchema,
      steps: z.array(PlanStepRowSchema),
    }),
    responseStatus: "201",
  },
  {
    operationId: "plans_list",
    endpoint: "plans",
    method: "GET",
    handler: handleListPlans,
    summary: "List recent plans",
    description:
      "Return the most recently updated plans for the given scope. Default scope is 'default'.",
    tags: ["plans"],
    queryParams: [
      {
        name: "scopeId",
        type: "string",
        description: "Scope filter, defaults to 'default'.",
      },
      {
        name: "limit",
        type: "integer",
        description: "Max plans to return (1-200, default 50).",
      },
    ],
    responseBody: z.object({ plans: z.array(PlanRowSchema) }),
  },
  {
    operationId: "plans_get",
    endpoint: "plans/:id",
    method: "GET",
    handler: handleGetPlan,
    summary: "Get a plan by id",
    description:
      "Return one plan with its ordered steps and all step-run attempts.",
    tags: ["plans"],
    pathParams: [{ name: "id", type: "string" }],
    responseBody: z.object({
      plan: PlanRowSchema,
      steps: z.array(PlanStepRowSchema),
      runs: z.record(z.string(), z.array(PlanStepRunRowSchema)),
    }),
  },
  {
    operationId: "plans_cancel",
    endpoint: "plans/:id/cancel",
    method: "POST",
    handler: handleCancelPlan,
    summary: "Cancel a plan",
    description:
      "Flip the plan to status='cancelled' so the runner stops between steps. No-op for already-terminal plans.",
    tags: ["plans"],
    pathParams: [{ name: "id", type: "string" }],
    requestBody: z.object({
      reason: z.string().max(240).optional(),
    }),
    responseBody: z.object({
      plan: PlanRowSchema,
      cancelled: z.boolean(),
    }),
  },
  {
    operationId: "plans_step_update_status",
    endpoint: "plans/:id/steps/:stepId/status",
    method: "POST",
    handler: handleUpdateStepStatus,
    summary: "Update a plan step status",
    description:
      "Record visible progress for a confirmed plan step. This does not execute host actions.",
    tags: ["plans"],
    pathParams: [
      { name: "id", type: "string" },
      { name: "stepId", type: "string" },
    ],
    requestBody: UpdateStepStatusBodySchema,
    responseBody: z.object({
      plan: PlanRowSchema,
      steps: z.array(PlanStepRowSchema),
      step: PlanStepRowSchema,
    }),
  },
];
