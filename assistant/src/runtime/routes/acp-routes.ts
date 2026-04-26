/**
 * Route handlers for ACP (Agent Communication Protocol) session lifecycle.
 *
 * Exposes spawn, steer, cancel, close, sessions, and permission operations
 * over HTTP.
 */
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  broadcastToAllClients,
  getAcpSessionManager,
} from "../../acp/index.js";
import { resolveAcpAgent } from "../../acp/resolve-agent.js";
import type { AcpSessionState } from "../../acp/types.js";
import { getDb } from "../../memory/db.js";
import { acpSessionHistory } from "../../memory/schema.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("acp-routes");

/** Default cap when no `?limit` query param is provided. */
const DEFAULT_SESSION_LIMIT = 50;
/** Hard ceiling on `?limit` to keep response sizes bounded. */
const MAX_SESSION_LIMIT = 500;

/**
 * Wire shape for a single entry in `GET /v1/acp/sessions`. Combines the
 * runtime state of an in-memory session (`AcpSessionState`) with the
 * historical fields persisted on terminal transition. `eventLog` is the
 * deserialized form of the DB's `event_log_json` column.
 */
const sessionEntrySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  acpSessionId: z.string(),
  parentConversationId: z.string().optional(),
  status: z.string(),
  startedAt: z.number(),
  completedAt: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  stopReason: z.string().nullable().optional(),
  eventLog: z.array(z.unknown()).optional(),
});

type SessionEntry = z.infer<typeof sessionEntrySchema>;

export function acpRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "acp/spawn",
      method: "POST",
      policyKey: "acp/spawn",
      summary: "Spawn ACP session",
      description: "Start a new Agent Communication Protocol session.",
      tags: ["acp"],
      requestBody: z.object({
        agent: z.string().describe("Agent name"),
        task: z.string().describe("Task description"),
        conversationId: z.string(),
        cwd: z.string().describe("Working directory").optional(),
      }),
      responseBody: z.object({
        acpSessionId: z.string(),
        protocolSessionId: z.string(),
        agent: z.string(),
      }),
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          agent?: string;
          task?: string;
          conversationId?: string;
          cwd?: string;
        };
        if (!body.agent || !body.task || !body.conversationId) {
          return httpError(
            "BAD_REQUEST",
            "agent, task, and conversationId are required",
            400,
          );
        }
        const resolved = resolveAcpAgent(body.agent);
        if (!resolved.ok) {
          switch (resolved.reason) {
            case "acp_disabled":
              return httpError("BAD_REQUEST", resolved.hint, 400);
            case "unknown_agent":
              return httpError(
                "BAD_REQUEST",
                `Unknown agent "${body.agent}". Available: ${resolved.available.join(", ")}.`,
                400,
              );
            case "binary_not_found":
              // 424 FAILED_DEPENDENCY: input is well-formed, but the host
              // environment is missing the adapter binary — clients render
              // the install hint as a setup step, not a "fix your input"
              // error.
              return httpError(
                "FAILED_DEPENDENCY",
                `${resolved.command} is not on PATH. ${resolved.hint}`,
                424,
              );
            default: {
              const _exhaustive: never = resolved;
              throw new Error(
                `Unexpected acp resolver reason: ${(_exhaustive as { reason: string }).reason}`,
              );
            }
          }
        }
        log.info(
          {
            agent: body.agent,
            task: body.task?.slice(0, 100),
            conversationId: body.conversationId,
          },
          "ACP spawn request received",
        );
        const manager = getAcpSessionManager();
        const sendToVellum =
          broadcastToAllClients ?? ((_msg) => log.warn("No broadcast fn set"));
        const { acpSessionId, protocolSessionId } = await manager.spawn(
          body.agent,
          resolved.agent,
          body.task,
          body.cwd ?? process.cwd(),
          body.conversationId,
          sendToVellum,
        );
        log.info(
          { acpSessionId, protocolSessionId, agent: body.agent },
          "ACP spawn succeeded",
        );
        return Response.json({
          acpSessionId,
          protocolSessionId,
          agent: body.agent,
        });
      },
    },

    {
      endpoint: "acp/:id/steer",
      method: "POST",
      policyKey: "acp/steer",
      summary: "Steer ACP session",
      description: "Send a steering instruction to an active ACP session.",
      tags: ["acp"],
      requestBody: z.object({
        instruction: z.string(),
      }),
      responseBody: z.object({
        acpSessionId: z.string(),
        steered: z.boolean(),
      }),
      handler: async ({ req, params }) => {
        const body = (await req.json()) as { instruction?: string };
        if (!body.instruction) {
          return httpError("BAD_REQUEST", "instruction is required", 400);
        }
        const manager = getAcpSessionManager();
        try {
          await manager.steer(params.id, body.instruction);
        } catch {
          return httpError("NOT_FOUND", "ACP session not found", 404);
        }
        return Response.json({ acpSessionId: params.id, steered: true });
      },
    },

    {
      endpoint: "acp/:id/cancel",
      method: "POST",
      policyKey: "acp/cancel",
      summary: "Cancel ACP session",
      description: "Cancel an active ACP session.",
      tags: ["acp"],
      responseBody: z.object({
        acpSessionId: z.string(),
        cancelled: z.boolean(),
      }),
      handler: async ({ params }) => {
        const manager = getAcpSessionManager();
        try {
          await manager.cancel(params.id);
        } catch {
          return httpError("NOT_FOUND", "ACP session not found", 404);
        }
        return Response.json({ acpSessionId: params.id, cancelled: true });
      },
    },

    {
      endpoint: "acp/:id/close",
      method: "POST",
      policyKey: "acp/close",
      summary: "Close ACP session",
      description: "Close a completed ACP session.",
      tags: ["acp"],
      responseBody: z.object({
        acpSessionId: z.string(),
        closed: z.boolean(),
      }),
      handler: async ({ params }) => {
        const manager = getAcpSessionManager();
        try {
          manager.close(params.id);
        } catch {
          return httpError("NOT_FOUND", "ACP session not found", 404);
        }
        return Response.json({ acpSessionId: params.id, closed: true });
      },
    },

    {
      endpoint: "acp/sessions",
      method: "GET",
      policyKey: "acp",
      summary: "List ACP sessions",
      description:
        "Return the merged set of in-memory and persisted ACP sessions, " +
        "newest first. In-memory sessions take precedence on id collision.",
      tags: ["acp"],
      queryParams: [
        {
          name: "limit",
          type: "integer",
          required: false,
          description: `Maximum number of sessions to return (default ${DEFAULT_SESSION_LIMIT}, max ${MAX_SESSION_LIMIT}).`,
        },
        {
          name: "conversationId",
          type: "string",
          required: false,
          description:
            "Filter to sessions whose parentConversationId matches this value.",
        },
      ],
      responseBody: z.object({
        sessions: z
          .array(sessionEntrySchema)
          .describe("Merged in-memory and persisted ACP sessions."),
      }),
      handler: ({ url }) => {
        const limit = parseLimit(url.searchParams.get("limit"));
        const conversationId =
          url.searchParams.get("conversationId") ?? undefined;
        const sessions = listMergedSessions({ limit, conversationId });
        return Response.json({ sessions });
      },
    },
  ];
}

/**
 * Parses the `?limit` query param. Falls back to the default when missing
 * or non-numeric, and clamps positive values to `MAX_SESSION_LIMIT`. Zero
 * and negative values fall back to the default rather than empty results.
 */
function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_SESSION_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SESSION_LIMIT;
  return Math.min(Math.floor(n), MAX_SESSION_LIMIT);
}

/**
 * Merges in-memory sessions (`getStatus()`) with persisted history rows,
 * deduping by id (in-memory wins), optionally filtering by parent
 * conversation, sorting newest-first, and truncating to `limit`.
 */
function listMergedSessions(opts: {
  limit: number;
  conversationId?: string;
}): SessionEntry[] {
  const manager = getAcpSessionManager();
  const inMemory = manager.getStatus() as AcpSessionState[];

  const merged = new Map<string, SessionEntry>();
  for (const s of inMemory) {
    if (opts.conversationId && s.parentConversationId !== opts.conversationId) {
      continue;
    }
    merged.set(s.id, {
      id: s.id,
      agentId: s.agentId,
      acpSessionId: s.acpSessionId,
      parentConversationId: s.parentConversationId,
      status: s.status,
      startedAt: s.startedAt,
      completedAt: s.completedAt ?? null,
      error: s.error ?? null,
      stopReason: s.stopReason ?? null,
    });
  }

  // The DB-side conversationId filter uses the
  // `idx_acp_session_history_parent_conversation_id` index, and the
  // newest-first sort uses `idx_acp_session_history_started_at`.
  const db = getDb();
  const baseQuery = db.select().from(acpSessionHistory);
  const filtered = opts.conversationId
    ? baseQuery.where(
        eq(acpSessionHistory.parentConversationId, opts.conversationId),
      )
    : baseQuery;
  const historyRows = filtered.orderBy(desc(acpSessionHistory.startedAt)).all();

  for (const row of historyRows) {
    if (merged.has(row.id)) continue; // in-memory wins on collision
    let eventLog: unknown[] = [];
    try {
      const parsed = JSON.parse(row.eventLogJson) as unknown;
      if (Array.isArray(parsed)) eventLog = parsed;
    } catch (err) {
      log.warn(
        { id: row.id, err },
        "Failed to parse event_log_json for ACP session history row",
      );
    }
    merged.set(row.id, {
      id: row.id,
      agentId: row.agentId,
      acpSessionId: row.acpSessionId,
      parentConversationId: row.parentConversationId,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      error: row.error,
      stopReason: row.stopReason,
      eventLog,
    });
  }

  return Array.from(merged.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, opts.limit);
}
