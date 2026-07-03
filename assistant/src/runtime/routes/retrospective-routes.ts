/**
 * Route handlers for memory retrospective background runs.
 *
 * Retrospectives are per-conversation background passes that review recent
 * activity in a source conversation and persist durable memories. They are
 * event-driven — enqueued by per-conversation triggers (time/message-count
 * thresholds after activity, pre-compaction) via
 * `maybeEnqueueMemoryRetrospective` in `memory/memory-retrospective-enqueue.ts`
 * — never globally scheduled, so there is no run-now endpoint and `nextRunAt`
 * is always null. These routes only surface config and run history for the
 * Settings UI.
 *
 * `available` gates on `memory.enabled` alone (matching `isMemoryEnabled` in
 * the enqueue path). Retrospectives do NOT depend on `memory.v2.enabled`.
 */

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import type { ConversationRow } from "../../persistence/conversation-crud.js";
import {
  getMessageRoleStatsByConversation,
  listConversationsBySource,
} from "../../persistence/conversation-queries.js";
import { isMemoryEnabled } from "../../persistence/jobs-store.js";
import { getUsageCostForConversationWindow } from "../../persistence/llm-usage-store.js";
import {
  MEMORY_RETROSPECTIVE_FORK_SOURCE,
  MEMORY_RETROSPECTIVE_SOURCE,
} from "../../plugins/defaults/memory/memory-retrospective-constants.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  paginateRuns,
  parseRunsBeforeCursor,
  parseRunsLimit,
  RUNS_NEXT_CURSOR_SCHEMA,
  RUNS_PAGINATION_QUERY_PARAMS,
} from "./runs-pagination.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

type RetrospectiveKind = "legacy" | "fork";

const SOURCE_KINDS: ReadonlyArray<{
  source: string;
  kind: RetrospectiveKind;
}> = [
  { source: MEMORY_RETROSPECTIVE_SOURCE, kind: "legacy" },
  { source: MEMORY_RETROSPECTIVE_FORK_SOURCE, kind: "fork" },
];

/**
 * Fetch the most recent retrospective conversations across BOTH source
 * sentinels (legacy + fork), newest first. Fetches `limit` rows from each
 * source before merging so the merged top-N is correct regardless of how
 * runs are distributed across kinds. The same `before` cursor applies to
 * each source query, so paging never skips rows from either kind.
 */
function listRetrospectiveConversations(
  limit: number,
  before?: number,
): Array<{ row: ConversationRow; kind: RetrospectiveKind }> {
  const merged = SOURCE_KINDS.flatMap(({ source, kind }) =>
    listConversationsBySource(source, limit, {
      beforeCreatedAt: before,
    }).map((row) => ({ row, kind })),
  );
  merged.sort((a, b) => b.row.createdAt - a.row.createdAt);
  return merged.slice(0, limit);
}

function readRetrospectiveConfigResponse() {
  const config = getConfig();
  const available = isMemoryEnabled();
  const enabled = available;
  const intervalMs = config.memory.retrospective.timeThresholdMs;
  // Retrospectives have no global schedule — runs are triggered per
  // conversation after activity, so a future run time is never known.
  const nextRunAt = null;
  const lastRunAt = listRetrospectiveConversations(1)[0]?.row.createdAt ?? null;
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
    operationId: "getRetrospectiveConfig",
    endpoint: "retrospective/config",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get memory retrospective config",
    description:
      "Return the memory retrospective configuration. Retrospectives are " +
      "event-driven background passes triggered per conversation after " +
      "activity (time/message thresholds, pre-compaction) — there is no " +
      "global schedule, so `nextRunAt` is always null and no run-now " +
      "endpoint exists. `intervalMs` is the per-conversation time threshold " +
      "(`memory.retrospective.timeThresholdMs`), `lastRunAt` is the " +
      "`createdAt` of the most recent retrospective conversation across " +
      "both legacy and fork sources, and `available` gates on " +
      "`memory.enabled` (not `memory.v2.enabled`).",
    tags: ["retrospective"],
    responseBody: z.object({
      available: z.boolean(),
      enabled: z.boolean(),
      intervalMs: z.number(),
      nextRunAt: z.number().nullable(),
      lastRunAt: z.number().nullable(),
      success: z.boolean(),
    }),
    handler: async (_args: RouteHandlerArgs) => {
      return readRetrospectiveConfigResponse();
    },
  },
  {
    operationId: "listRetrospectiveRuns",
    endpoint: "retrospective/runs",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List memory retrospective runs",
    description:
      "Return recent memory retrospective conversations as run records, " +
      "merged across both sources (`memory-retrospective` → kind `legacy`, " +
      "`memory-retrospective-fork` → kind `fork`) and sorted newest first. " +
      "Each retrospective dispatch creates exactly one background " +
      "conversation; that conversation IS the run. Shape mirrors " +
      "`consolidation/runs` (synthetic `id`/`scheduledFor`/`startedAt` from " +
      "the conversation row, `finishedAt`/`status` from assistant-message " +
      "presence, `skipReason`/`error` always null) plus `kind` and `title` " +
      "(fork runs are titled '<source title> (Retrospective)', which " +
      "identifies what was reviewed). For fork runs, copied source messages " +
      "keep their original timestamps, so only assistant messages at or " +
      "after the fork's creation count as agent output. NOTE: superseded " +
      "runs are garbage-collected by default " +
      "(`memory.retrospective.keepSupersededRuns: false` deletes the prior " +
      "run when a newer one succeeds), so this lists what currently exists " +
      "— typically the most recent run per source conversation unless the " +
      "operator retains history.",
    tags: ["retrospective"],
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
            kind: z.enum(["legacy", "fork"]),
            title: z.string().nullable(),
          }),
        )
        .describe("Retrospective run records"),
      nextCursor: RUNS_NEXT_CURSOR_SCHEMA,
    }),
    handler: async ({ queryParams }: RouteHandlerArgs) => {
      const params = queryParams ?? {};
      const limit = parseRunsLimit(params, 20);
      const before = parseRunsBeforeCursor(params);
      const { rows, nextCursor } = paginateRuns(
        listRetrospectiveConversations(limit + 1, before),
        limit,
        (r) => r.row.createdAt,
      );
      const assistantStats = getMessageRoleStatsByConversation(
        rows.map((r) => r.row.id),
        "assistant",
      );
      const now = Date.now();
      return {
        nextCursor,
        runs: rows.map(({ row: c, kind }) => {
          const stat = assistantStats.get(c.id);
          // Fork-based retrospectives copy the source conversation's
          // messages with their ORIGINAL timestamps, so assistant messages
          // can predate the fork row's createdAt. Only an assistant message
          // at-or-after the conversation's creation is evidence the
          // retrospective agent itself emitted output — without this guard
          // an in-flight fork run would read "ok" with a negative duration.
          const hasAssistantOutput = stat != null && stat.lastAt >= c.createdAt;
          const finishedAt = hasAssistantOutput ? stat.lastAt : null;
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
            kind,
            title: c.title ?? null,
          };
        }),
      };
    },
  },
];
