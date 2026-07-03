/**
 * Route handlers for filing management.
 *
 * `available` reflects whether PKB filing is the active background memory job
 * for this instance. When `config.memory.v2.enabled` is true, filing yields to
 * the consolidation job (see consolidation-routes.ts); when `memory.enabled`
 * is false, the memory jobs worker never runs filing jobs. Both cases return
 * `available: false` so the UI can hide the row.
 *
 * Filing runs as a `pkb_filing` background job: the jobs-worker's maintenance
 * scheduler enqueues it on a durable checkpoint, and the status here reads
 * that checkpoint. "Run now" enqueues a job directly (with `force`, bypassing
 * the empty-buffer skip) rather than executing inline.
 */

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { getMemoryCheckpoint } from "../../persistence/checkpoints.js";
import {
  enqueueMemoryJob,
  hasActiveJobOfType,
} from "../../persistence/jobs-store.js";
import { GRAPH_MAINTENANCE_CHECKPOINTS } from "../../persistence/jobs-worker.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

function isFilingAvailable(): boolean {
  const config = getConfig();
  // Filing runs through the memory jobs worker, whose slow lane is parked
  // while memory is disabled — an enqueued job would sit pending forever, so
  // report unavailable (and reject run-now) rather than queue dead work.
  return config.memory.enabled !== false && !config.memory.v2.enabled;
}

// ---------------------------------------------------------------------------
// Shared ROUTES
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getFilingConfig",
    endpoint: "filing/config",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get filing config",
    description: "Return the current filing schedule configuration.",
    tags: ["filing"],
    responseBody: z.object({
      available: z.boolean(),
      enabled: z.boolean(),
      intervalMs: z.number(),
      activeHoursStart: z.number().nullable(),
      activeHoursEnd: z.number().nullable(),
      nextRunAt: z.number().nullable(),
      lastRunAt: z.number().nullable(),
      success: z.boolean(),
    }),
    handler: async (_args: RouteHandlerArgs) => {
      const config = getConfig().filing;
      // The maintenance scheduler's durable checkpoint: seeded to "now" the
      // first time the scheduler sees the job, then advanced on each
      // enqueue (or deliberate skip). Absent only before that first tick.
      const lastRun = parseInt(
        getMemoryCheckpoint(GRAPH_MAINTENANCE_CHECKPOINTS.pkbFiling) ?? "0",
        10,
      );
      const scheduled = isFilingAvailable() && config.enabled;
      return {
        available: isFilingAvailable(),
        enabled: config.enabled,
        intervalMs: config.intervalMs,
        activeHoursStart: config.activeHoursStart ?? null,
        activeHoursEnd: config.activeHoursEnd ?? null,
        // No checkpoint yet: the scheduler seeds it on its next tick, so the
        // first run lands roughly one interval from now.
        nextRunAt: scheduled
          ? (lastRun > 0 ? lastRun : Date.now()) + config.intervalMs
          : null,
        lastRunAt: lastRun > 0 ? lastRun : null,
        success: true,
      };
    },
  },
  {
    operationId: "runFilingNow",
    endpoint: "filing/run-now",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Run filing now",
    description:
      "Enqueue an immediate PKB filing job. Returns once the job is queued; " +
      "the job itself runs through the memory jobs worker.",
    tags: ["filing"],
    responseBody: z.object({
      success: z.boolean(),
      ran: z.boolean().describe("Whether a job was enqueued"),
    }),
    handler: async (_args: RouteHandlerArgs) => {
      if (!isFilingAvailable()) {
        throw new BadRequestError(
          "Filing is not available (memory is disabled or memory v2 is enabled)",
        );
      }
      // Coalesce: filing and compaction both rewrite the PKB tree, so don't
      // enqueue while either is already pending/running.
      if (
        hasActiveJobOfType("pkb_filing") ||
        hasActiveJobOfType("pkb_compaction")
      ) {
        return { success: true, ran: false };
      }
      enqueueMemoryJob("pkb_filing", { force: true });
      return { success: true, ran: true };
    },
  },
];
