import { z } from "zod";

import { computeNextBackgroundWakeIntent } from "../../background-wake/next-wake.js";
import { getBackgroundWakeRuntime } from "../../background-wake/runtime-registry.js";
import { BadRequestError, ServiceUnavailableError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const PREPARE_SLEEP_DEFER_WINDOW_MS = 60_000;
const HEARTBEAT_DUE_TOLERANCE_MS = 1_000;

let computeWakeIntent = computeNextBackgroundWakeIntent;
const timestampInputSchema = z.union([z.number(), z.string()]);

const wakeIntentSchema = z
  .object({
    nextWakeAt: z.number(),
    actualNextDueAt: z.number(),
    reason: z.enum(["heartbeat", "schedule", "mixed"]),
    sourceGeneration: z.string(),
    computedAt: z.number(),
    sourcePayload: z.record(z.string(), z.unknown()),
  })
  .nullable();

const normalizedDrainDueRequestSchema = z.object({
  leaseId: z.string().min(1),
  reason: z.string().min(1),
  sourceGeneration: z.string().min(1),
  startedAt: z.number(),
  deadlineAt: z.number(),
});

const drainDueRequestSchema = z.union([
  z.object({
    leaseId: z.string().min(1),
    reason: z.string().min(1),
    sourceGeneration: z.string().min(1),
    startedAt: timestampInputSchema,
    deadlineAt: timestampInputSchema,
  }),
  z.object({
    lease_id: z.string().min(1),
    reason: z.string().min(1),
    source_generation: z.string().min(1),
    started_at: timestampInputSchema,
    deadline_at: timestampInputSchema,
  }),
]);

function normalizeDrainDueBody(body: Record<string, unknown>) {
  return {
    leaseId: body.leaseId ?? body.lease_id,
    reason: body.reason,
    sourceGeneration: body.sourceGeneration ?? body.source_generation,
    startedAt: normalizeTimestamp(body.startedAt ?? body.started_at),
    deadlineAt: normalizeTimestamp(body.deadlineAt ?? body.deadline_at),
  };
}

function normalizeTimestamp(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function parseDrainDueBody(body: Record<string, unknown>) {
  const parsed = normalizedDrainDueRequestSchema.safeParse(
    normalizeDrainDueBody(body),
  );
  if (!parsed.success) {
    throw new BadRequestError(
      "leaseId, reason, sourceGeneration, startedAt, and deadlineAt are required",
    );
  }
  return parsed.data;
}

function handleGetIntent() {
  return { intent: computeWakeIntent() };
}

function handlePrepareSleep() {
  const now = Date.now();
  const intent = computeWakeIntent(now);
  return {
    intent,
    deferSleep:
      intent != null &&
      intent.nextWakeAt <= now + PREPARE_SLEEP_DEFER_WINDOW_MS,
  };
}

async function handleDrainDue(body: Record<string, unknown>) {
  const request = parseDrainDueBody(body);
  const runtime = getBackgroundWakeRuntime();
  if (!runtime) {
    throw new ServiceUnavailableError(
      "Background wake runtime is not registered",
    );
  }

  const now = Date.now();
  const heartbeatDue =
    runtime.heartbeat.nextRunAt != null &&
    runtime.heartbeat.nextRunAt <= now + HEARTBEAT_DUE_TOLERANCE_MS;
  const heartbeatRan = heartbeatDue ? await runtime.heartbeat.runOnce() : false;
  const scheduledCount = await runtime.scheduler.runOnce();

  return {
    leaseId: request.leaseId,
    reason: request.reason,
    sourceGeneration: request.sourceGeneration,
    startedAt: request.startedAt,
    deadlineAt: request.deadlineAt,
    counts: {
      heartbeat: heartbeatRan ? 1 : 0,
      scheduler: scheduledCount,
      total: (heartbeatRan ? 1 : 0) + scheduledCount,
    },
    nextIntent: computeWakeIntent(),
  };
}

/** @internal Test helper for route-only tests. */
export function setBackgroundWakeIntentComputerForTest(
  nextCompute: typeof computeNextBackgroundWakeIntent | null,
): void {
  computeWakeIntent = nextCompute ?? computeNextBackgroundWakeIntent;
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getBackgroundWakeIntent",
    endpoint: "background-wake/intent",
    method: "GET",
    policyKey: "background-wake",
    summary: "Get background wake intent",
    description: "Return the current computed background wake intent.",
    tags: ["background-wake"],
    responseBody: z.object({
      intent: wakeIntentSchema,
    }),
    handler: () => handleGetIntent(),
  },
  {
    operationId: "prepareBackgroundWakeSleep",
    endpoint: "background-wake/prepare-sleep",
    method: "POST",
    policyKey: "background-wake",
    summary: "Prepare for assistant sleep",
    description:
      "Return the current background wake intent and whether sleep should be deferred.",
    tags: ["background-wake"],
    responseBody: z.object({
      intent: wakeIntentSchema,
      deferSleep: z.boolean(),
    }),
    handler: () => handlePrepareSleep(),
  },
  {
    operationId: "drainDueBackgroundWake",
    endpoint: "background-wake/drain-due",
    method: "POST",
    policyKey: "background-wake",
    summary: "Drain due background wake work",
    description:
      "Run due heartbeat and scheduler work for a background wake lease.",
    tags: ["background-wake"],
    requestBody: drainDueRequestSchema,
    responseBody: z.object({
      leaseId: z.string(),
      reason: z.string(),
      sourceGeneration: z.string(),
      startedAt: z.number(),
      deadlineAt: z.number(),
      counts: z.object({
        heartbeat: z.number(),
        scheduler: z.number(),
        total: z.number(),
      }),
      nextIntent: wakeIntentSchema,
    }),
    handler: ({ body }: RouteHandlerArgs) => handleDrainDue(body ?? {}),
  },
];
