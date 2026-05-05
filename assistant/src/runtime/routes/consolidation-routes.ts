/**
 * Route handlers for the memory v2 consolidation job.
 *
 * Consolidation is the v2 counterpart to filing: an interval-based background
 * pass that routes accumulated `memory/buffer.md` entries into concept pages.
 * The job itself is enqueued by the memory jobs worker (see
 * `maybeEnqueueGraphMaintenanceJobs` in `memory/jobs-worker.ts`); these routes
 * only surface its config and provide an on-demand trigger for the Settings UI.
 *
 * `available` mirrors the filing route's `available` field: it reflects which
 * background memory job is active for this instance. When `memory-v2-enabled`
 * is off, consolidation returns `available: false` and the UI hides the row.
 */

import { z } from "zod";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { getMemoryCheckpoint } from "../../memory/checkpoints.js";
import {
  enqueueMemoryJob,
  hasActiveJobOfType,
} from "../../memory/jobs-store.js";
import { GRAPH_MAINTENANCE_CHECKPOINTS } from "../../memory/jobs-worker.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

function isConsolidationAvailable(): boolean {
  return isAssistantFeatureFlagEnabled("memory-v2-enabled", getConfig());
}

function consolidationIntervalMs(): number {
  return getConfig().memory.v2.consolidation_interval_hours * 60 * 60 * 1000;
}

function readLastRunAt(): number | null {
  const raw = getMemoryCheckpoint(
    GRAPH_MAINTENANCE_CHECKPOINTS.memoryV2Consolidate,
  );
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Shared ROUTES
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getConsolidationConfig",
    endpoint: "consolidation/config",
    method: "GET",
    policyKey: "consolidation",
    requirePolicyEnforcement: true,
    summary: "Get consolidation config",
    description:
      "Return the current memory v2 consolidation schedule configuration.",
    tags: ["consolidation"],
    responseBody: z.object({
      available: z.boolean(),
      enabled: z.boolean(),
      intervalMs: z.number(),
      nextRunAt: z.number().nullable(),
      lastRunAt: z.number().nullable(),
      success: z.boolean(),
    }),
    handler: async (_args: RouteHandlerArgs) => {
      const available = isConsolidationAvailable();
      const v2Config = getConfig().memory.v2;
      const intervalMs = consolidationIntervalMs();
      const lastRunAt = readLastRunAt();
      const nextRunAt = lastRunAt != null ? lastRunAt + intervalMs : null;
      return {
        available,
        enabled: available && v2Config.enabled,
        intervalMs,
        nextRunAt,
        lastRunAt,
        success: true,
      };
    },
  },
  {
    operationId: "runConsolidationNow",
    endpoint: "consolidation/run-now",
    method: "POST",
    policyKey: "consolidation",
    requirePolicyEnforcement: true,
    summary: "Run consolidation now",
    description:
      "Enqueue an immediate memory v2 consolidation job. Returns once the job is queued; the job itself runs through the memory jobs worker.",
    tags: ["consolidation"],
    responseBody: z.object({
      success: z.boolean(),
      ran: z.boolean().describe("Whether a job was enqueued"),
      jobId: z.string().nullable(),
    }),
    handler: async (_args: RouteHandlerArgs) => {
      if (!isConsolidationAvailable()) {
        throw new BadRequestError(
          "Consolidation is not available (memory-v2-enabled is off)",
        );
      }
      // Coalesce: don't pile up duplicate jobs if the worker hasn't picked up
      // the previous one yet. The consolidation job's own lock catches the
      // overlapping-window case but does not prevent queue depth from growing.
      if (hasActiveJobOfType("memory_v2_consolidate")) {
        return { success: true, ran: false, jobId: null };
      }
      const jobId = enqueueMemoryJob("memory_v2_consolidate", {});
      return { success: true, ran: true, jobId };
    },
  },
];
