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
 * background memory job is active for this instance. When
 * `config.memory.v2.enabled` is false, consolidation returns
 * `available: false` and the UI hides the row.
 */

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { getMemoryCheckpoint } from "../../persistence/checkpoints.js";
import {
  getMessageRoleStatsByConversation,
  listConversationsBySource,
} from "../../persistence/conversation-queries.js";
import {
  enqueueMemoryJob,
  hasActiveJobOfType,
  MEMORY_V2_CONSOLIDATION_JOB_TRIGGERS,
} from "../../persistence/jobs-store.js";
import { GRAPH_MAINTENANCE_CHECKPOINTS } from "../../persistence/jobs-worker.js";
import { getUsageCostForConversationWindow } from "../../persistence/llm-usage-store.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../../plugins/defaults/memory/v2/constants.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import {
  paginateRuns,
  parseRunsBeforeCursor,
  parseRunsLimit,
  RUNS_NEXT_CURSOR_SCHEMA,
  RUNS_PAGINATION_QUERY_PARAMS,
} from "./runs-pagination.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

function isConsolidationAvailable(): boolean {
  const config = getConfig();
  return config.memory.enabled !== false && config.memory.v2.enabled;
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

function readConsolidationConfigResponse() {
  const config = getConfig();
  const available = config.memory.enabled !== false && config.memory.v2.enabled;
  const enabled = available;
  const intervalMs = consolidationIntervalMs();
  const lastRunAt = readLastRunAt();
  const nextRunAt =
    enabled && lastRunAt != null ? lastRunAt + intervalMs : null;
  return {
    available,
    enabled,
    intervalMs,
    nextRunAt,
    lastRunAt,
    success: true,
  };
}

// ---------------------------------------------------------------------------
// Shared ROUTES
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getConsolidationConfig",
    endpoint: "consolidation/config",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
      return readConsolidationConfigResponse();
    },
  },
  {
    operationId: "runConsolidationNow",
    endpoint: "consolidation/run-now",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
          "Consolidation is not available (memory.v2.enabled is false)",
        );
      }
      // Coalesce: don't pile up duplicate jobs if the worker hasn't picked up
      // the previous one yet. The consolidation job's own lock catches the
      // overlapping-window case but does not prevent queue depth from growing.
      if (hasActiveJobOfType("memory_v2_consolidate")) {
        return { success: true, ran: false, jobId: null };
      }
      const jobId = enqueueMemoryJob("memory_v2_consolidate", {
        trigger: MEMORY_V2_CONSOLIDATION_JOB_TRIGGERS.manual,
      });
      return { success: true, ran: true, jobId };
    },
  },
  {
    operationId: "listConsolidationRuns",
    endpoint: "consolidation/runs",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List consolidation runs",
    description:
      "Return recent memory v2 consolidation conversations as run records. " +
      "Each consolidation dispatch creates exactly one background conversation " +
      "tagged with `source = memory_v2_consolidation`; that conversation IS " +
      "the run. Synthetic fields: `id` mirrors `conversationId` (no separate " +
      "run row exists), `scheduledFor` and `startedAt` both equal " +
      "`conversation.createdAt` (no separate schedule timestamp), " +
      "`finishedAt` is the `createdAt` of the latest assistant message in " +
      "the conversation (NOT `conversation.lastMessageAt`, which the kickoff " +
      "user prompt bumps before the agent runs). `status` is `'ok'` when " +
      "the conversation has at least one assistant message — i.e. positive " +
      "evidence the agent emitted output — otherwise `'running'`. This is a " +
      "weaker signal than heartbeat's `'ok'`: without a dedicated runs " +
      "table we cannot distinguish 'ran cleanly' from 'crashed after " +
      "emitting at least one assistant message'. `skipReason` and `error` " +
      "are always null — skipped runs (lock held, disabled, empty buffer) " +
      "never create a conversation, and run failure detail is not stored " +
      "on the conversation row. Shape mirrors `heartbeat/runs` so the " +
      "schedules settings UI can reuse its run-row component.",
    tags: ["consolidation"],
    queryParams: RUNS_PAGINATION_QUERY_PARAMS(20),
    responseBody: z.object({
      runs: z
        .array(
          z.object({
            id: z.string(),
            scheduledFor: z.number(),
            startedAt: z.number().nullable(),
            finishedAt: z.number().nullable(),
            durationMs: z.number().nullable(),
            status: z.enum(["ok", "running"]),
            skipReason: z.string().nullable(),
            error: z.string().nullable(),
            conversationId: z.string().nullable(),
            conversationExists: z.boolean(),
            conversationArchivedAt: z.number().nullable(),
            estimatedCostUsd: z.number(),
            createdAt: z.number(),
          }),
        )
        .describe("Consolidation run records"),
      nextCursor: RUNS_NEXT_CURSOR_SCHEMA,
    }),
    handler: async ({ queryParams }: RouteHandlerArgs) => {
      const params = queryParams ?? {};
      const limit = parseRunsLimit(params, 20);
      const before = parseRunsBeforeCursor(params);
      const { rows, nextCursor } = paginateRuns(
        listConversationsBySource(MEMORY_V2_CONSOLIDATION_SOURCE, limit + 1, {
          beforeCreatedAt: before,
        }),
        limit,
        (c) => c.createdAt,
      );
      // Aggregate assistant-message stats in one batched query: presence of
      // an assistant message is the strongest "agent emitted output" signal
      // available without a dedicated consolidation runs table. The kickoff
      // user prompt is persisted via `addMessage` before the agent run,
      // which bumps `conversations.lastMessageAt` — so that field cannot
      // be used to infer completion.
      const assistantStats = getMessageRoleStatsByConversation(
        rows.map((r) => r.id),
        "assistant",
      );
      const now = Date.now();
      return {
        nextCursor,
        runs: rows.map((c) => {
          const stat = assistantStats.get(c.id);
          const hasAssistantOutput = (stat?.count ?? 0) > 0;
          const finishedAt = hasAssistantOutput ? stat!.lastAt : null;
          const estimatedCostUsd =
            c.totalEstimatedCost > 0
              ? c.totalEstimatedCost
              : getUsageCostForConversationWindow({
                  conversationId: c.id,
                  from: c.createdAt,
                  to: finishedAt ?? now,
                });
          return {
            id: c.id,
            scheduledFor: c.createdAt,
            startedAt: c.createdAt,
            finishedAt,
            durationMs: finishedAt != null ? finishedAt - c.createdAt : null,
            status: (hasAssistantOutput ? "ok" : "running") as "ok" | "running",
            skipReason: null,
            error: null,
            conversationId: c.id,
            conversationExists: true,
            conversationArchivedAt: c.archivedAt,
            estimatedCostUsd,
            createdAt: c.createdAt,
          };
        }),
      };
    },
  },
];
