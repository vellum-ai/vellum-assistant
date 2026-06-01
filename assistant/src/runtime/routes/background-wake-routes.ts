import { z } from "zod";

import {
  type BackgroundWakeIntent,
  computeNextBackgroundWakeIntent,
} from "../../background-wake/next-wake.js";
import type { BackgroundWakeRuntime } from "../../background-wake/runtime-registry.js";
import { getBackgroundWakeRuntime } from "../../background-wake/runtime-registry.js";
import { getLogger } from "../../util/logger.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, ServiceUnavailableError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const PREPARE_SLEEP_DEFER_WINDOW_MS = 60_000;
const HEARTBEAT_DUE_TOLERANCE_MS = 1_000;
const MIN_DRAIN_START_BUDGET_MS = 5_000;
const LEASE_RENEW_INTERVAL_MS = 120_000;
const log = getLogger("background-wake-routes");

class DrainDeadlineElapsedError extends Error {
  constructor() {
    super("background wake lease deadline elapsed before starting work");
    this.name = "DrainDeadlineElapsedError";
  }
}

type RenewWakeLease = (leaseId: string) => Promise<unknown>;
type CompleteWakeLease = (args: {
  leaseId: string;
  status: "completed" | "failed" | "expired";
  error?: string;
  nextIntent?: BackgroundWakeIntent | null;
}) => Promise<unknown>;

let computeWakeIntent = computeNextBackgroundWakeIntent;
let renewWakeLease: RenewWakeLease = defaultRenewWakeLease;
let completeWakeLease: CompleteWakeLease = defaultCompleteWakeLease;
const activeDrainLeases = new Set<string>();
const activeDrainPromises = new Set<Promise<void>>();
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

type DrainDueRequest = z.infer<typeof normalizedDrainDueRequestSchema>;
function parseDrainDueBody(body: Record<string, unknown>): DrainDueRequest {
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

async function defaultRenewWakeLease(leaseId: string): Promise<unknown> {
  const { renewBackgroundWakeLease } =
    await import("../../background-wake/platform-client.js");
  return renewBackgroundWakeLease(leaseId);
}

async function defaultCompleteWakeLease(
  args: Parameters<CompleteWakeLease>[0],
): Promise<unknown> {
  const { completeBackgroundWakeLease } =
    await import("../../background-wake/platform-client.js");
  return completeBackgroundWakeLease(args);
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

  if (!activeDrainLeases.has(request.leaseId)) {
    activeDrainLeases.add(request.leaseId);
    const drainPromise = runDrainDueLease(request, runtime);
    activeDrainPromises.add(drainPromise);
    void drainPromise.finally(() => activeDrainPromises.delete(drainPromise));
  }

  return {
    accepted: true,
    leaseId: request.leaseId,
    reason: request.reason,
    sourceGeneration: request.sourceGeneration,
    startedAt: request.startedAt,
    deadlineAt: request.deadlineAt,
  };
}

async function runDrainDueLease(
  request: DrainDueRequest,
  runtime: BackgroundWakeRuntime,
): Promise<void> {
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  try {
    renewTimer = setInterval(() => {
      void renewWakeLease(request.leaseId).catch(() => {});
    }, LEASE_RENEW_INTERVAL_MS);
    renewTimer.unref?.();

    assertDrainCanStart(request.deadlineAt);
    const result = await performDrainDue(request, runtime);
    await reportLeaseCompletion({
      leaseId: request.leaseId,
      status: "completed",
      nextIntent: result.nextIntent,
    });
  } catch (error) {
    await reportLeaseCompletion({
      leaseId: request.leaseId,
      status: completionStatusForError(error),
      error: error instanceof Error ? error.message : String(error),
      nextIntent: computeWakeIntent(),
    });
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    activeDrainLeases.delete(request.leaseId);
  }
}

async function reportLeaseCompletion(
  args: Parameters<CompleteWakeLease>[0],
): Promise<void> {
  try {
    await completeWakeLease(args);
  } catch (err) {
    log.warn(
      { err, leaseId: args.leaseId, status: args.status },
      "Failed to report background wake lease completion",
    );
  }
}

async function performDrainDue(
  request: DrainDueRequest,
  runtime: BackgroundWakeRuntime,
) {
  const now = Date.now();
  const currentIntent = computeWakeIntent(now);
  const heartbeatDue = isHeartbeatTimerDue(runtime.heartbeat.nextRunAt, now);
  const schedulerDue =
    heartbeatDue ||
    reasonIncludesSource(request.reason, "schedule") ||
    intentHasDueSource(currentIntent, "schedule", now);

  if (heartbeatDue) {
    if (hasStartBudget(request.deadlineAt)) {
      await runtime.heartbeat.runManagedWakeIfDue({
        now,
        toleranceMs: HEARTBEAT_DUE_TOLERANCE_MS,
        scheduledFor: request.startedAt,
      });
    }
  }

  if (schedulerDue) {
    await runtime.scheduler.runDueWorkOnce({
      deadlineAt: request.deadlineAt,
      minStartBudgetMs: MIN_DRAIN_START_BUDGET_MS,
      includeStillPending: true,
    });
  }

  const nextIntent = computeWakeIntent();

  return {
    nextIntent,
  };
}

function assertDrainCanStart(deadlineAt: number): void {
  if (deadlineAt <= Date.now()) {
    throw new DrainDeadlineElapsedError();
  }
}

function completionStatusForError(error: unknown): "failed" | "expired" {
  return error instanceof DrainDeadlineElapsedError ? "expired" : "failed";
}

function reasonIncludesSource(
  reason: string,
  source: "heartbeat" | "schedule",
): boolean {
  return reason === "mixed" || reason === source;
}

function isHeartbeatTimerDue(nextRunAt: number | null, now: number): boolean {
  return nextRunAt != null && nextRunAt <= now + HEARTBEAT_DUE_TOLERANCE_MS;
}

function intentHasDueSource(
  intent: BackgroundWakeIntent | null,
  source: "heartbeat" | "schedule",
  now: number,
): boolean {
  return (
    intent != null &&
    intent.actualNextDueAt <= now + HEARTBEAT_DUE_TOLERANCE_MS &&
    reasonIncludesSource(intent.reason, source)
  );
}

function hasStartBudget(deadlineAt: number): boolean {
  return deadlineAt - Date.now() >= MIN_DRAIN_START_BUDGET_MS;
}

/** @internal Test helper for route-only tests. */
export function setBackgroundWakeIntentComputerForTest(
  nextCompute: typeof computeNextBackgroundWakeIntent | null,
): void {
  computeWakeIntent = nextCompute ?? computeNextBackgroundWakeIntent;
}

/** @internal Test helper for route-only tests. */
export function setBackgroundWakeLeaseClientForTest(
  nextClient: {
    renew: RenewWakeLease;
    complete: CompleteWakeLease;
  } | null,
): void {
  renewWakeLease = nextClient?.renew ?? defaultRenewWakeLease;
  completeWakeLease = nextClient?.complete ?? defaultCompleteWakeLease;
}

/** @internal Test helper for route-only tests. */
export async function flushBackgroundWakeDrainsForTest(): Promise<void> {
  while (activeDrainPromises.size > 0) {
    await Promise.allSettled([...activeDrainPromises]);
  }
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getBackgroundWakeIntent",
    endpoint: "background-wake/intent",
    method: "GET",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Drain due background wake work",
    description:
      "Run due heartbeat and scheduler work for a background wake lease.",
    tags: ["background-wake"],
    requestBody: drainDueRequestSchema,
    responseBody: z.object({
      accepted: z.boolean(),
      leaseId: z.string(),
      reason: z.string(),
      sourceGeneration: z.string(),
      startedAt: z.number(),
      deadlineAt: z.number(),
    }),
    handler: ({ body }: RouteHandlerArgs) => handleDrainDue(body ?? {}),
  },
];
