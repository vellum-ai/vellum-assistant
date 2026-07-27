/**
 * Lifecycle drain endpoints backing `vellum sleep --wait`.
 *
 * The quiesce lease pauses the STARTING of new background LLM work (heartbeat
 * beats, schedule/watcher/sequence claims, memory-job claims) across the
 * daemon and its worker processes; drain-status reports what is still in
 * flight so a client can wait for the assistant to go idle before stopping
 * it. Enqueue paths stay open — work queued during a drain runs after the
 * next start. The lease is TTL-bound and refreshed by the waiting client, so
 * an abandoned drain can never leave background work paused.
 */

import { z } from "zod";

import { readActiveConversations } from "../../monitoring/active-conversations.js";
import { listRunningMemoryJobs } from "../../persistence/jobs-store.js";
import {
  clearLifecycleQuiesce,
  DEFAULT_QUIESCE_TTL_MS,
  getLifecycleQuiesceUntil,
  setLifecycleQuiesce,
} from "../../persistence/lifecycle-quiesce.js";
import { listRunningScheduleRuns } from "../../schedule/schedule-store.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("lifecycle-routes");

const quiesceResponseSchema = z.object({
  quiescedUntil: z
    .number()
    .describe("Epoch ms when the quiesce lease expires."),
});

const activeConversationSchema = z.object({
  conversationId: z.string(),
  title: z.string().nullable(),
  originChannel: z.string().nullable(),
  originInterface: z.string().nullable(),
  processingStartedAt: z.number(),
});

const runningMemoryJobSchema = z.object({
  id: z.string(),
  type: z.string(),
  startedAt: z.number().nullable(),
});

const runningScheduleRunSchema = z.object({
  runId: z.string(),
  scheduleName: z.string().nullable(),
  startedAt: z.number(),
});

const drainStatusResponseSchema = z.object({
  quiescedUntil: z.number().nullable(),
  idle: z
    .boolean()
    .describe(
      "True when no conversation turn, memory job, or schedule run is in flight.",
    ),
  activeConversations: z.array(activeConversationSchema),
  memoryJobs: z.array(runningMemoryJobSchema),
  scheduleRuns: z.array(runningScheduleRunSchema),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "quiesceLifecycle",
    endpoint: "lifecycle/quiesce",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Arm or refresh the drain quiesce lease",
    description:
      "Pauses the starting of new background work (heartbeat, schedules, watchers, sequences, memory jobs) for the lease TTL. Refresh by calling again; the lease self-expires so an abandoned drain never leaves background work paused.",
    tags: ["system"],
    requestBody: z.object({
      ttlMs: z
        .number()
        .optional()
        .describe("Lease TTL in ms (clamped to a sane range)."),
    }),
    responseBody: quiesceResponseSchema,
    handler: (args: RouteHandlerArgs) => {
      const raw = args.body?.ttlMs;
      let ttlMs = DEFAULT_QUIESCE_TTL_MS;
      if (raw !== undefined) {
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          throw new BadRequestError("ttlMs must be a finite number");
        }
        ttlMs = raw;
      }
      const quiescedUntil = setLifecycleQuiesce(ttlMs);
      log.info({ quiescedUntil }, "Lifecycle quiesce lease armed");
      return { quiescedUntil };
    },
  },
  {
    operationId: "releaseLifecycleQuiesce",
    endpoint: "lifecycle/quiesce",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Release the drain quiesce lease",
    description:
      "Resumes background work immediately instead of waiting for the lease TTL to expire (e.g. when a drain is cancelled).",
    tags: ["system"],
    responseBody: z.object({ released: z.boolean() }),
    handler: () => {
      clearLifecycleQuiesce();
      log.info("Lifecycle quiesce lease released");
      return { released: true };
    },
  },
  {
    operationId: "getLifecycleDrainStatus",
    endpoint: "lifecycle/drain-status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "In-flight background work",
    description:
      "Reports conversation turns, memory jobs, and schedule runs currently in flight, plus the active quiesce lease. `idle: true` means it is safe to stop the assistant without interrupting work.",
    tags: ["system"],
    responseBody: drainStatusResponseSchema,
    handler: () => {
      const activeConversations = readActiveConversations() ?? [];
      // Best-effort per source: a store that cannot be read reports empty
      // rather than failing the whole snapshot — the caller's wait then
      // converges on what is observable.
      let memoryJobs: ReturnType<typeof listRunningMemoryJobs> = [];
      try {
        memoryJobs = listRunningMemoryJobs();
      } catch (err) {
        log.warn({ err }, "Drain status: memory jobs unavailable");
      }
      let scheduleRuns: ReturnType<typeof listRunningScheduleRuns> = [];
      try {
        scheduleRuns = listRunningScheduleRuns();
      } catch (err) {
        log.warn({ err }, "Drain status: schedule runs unavailable");
      }
      return {
        quiescedUntil: getLifecycleQuiesceUntil(),
        idle:
          activeConversations.length === 0 &&
          memoryJobs.length === 0 &&
          scheduleRuns.length === 0,
        activeConversations,
        memoryJobs,
        scheduleRuns,
      };
    },
  },
];
