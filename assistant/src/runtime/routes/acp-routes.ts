/**
 * Route handlers for ACP (Agent Communication Protocol) session lifecycle.
 *
 * Exposes spawn, steer, cancel, close, sessions, and permission operations
 * over HTTP.
 */
import { z } from "zod";

import {
  broadcastToAllClients,
  getAcpSessionManager,
} from "../../acp/index.js";
import { resolveAcpAgent } from "../../acp/resolve-agent.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("acp-routes");

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
          if (resolved.reason === "acp_disabled") {
            return httpError("BAD_REQUEST", resolved.hint, 400);
          }
          if (resolved.reason === "unknown_agent") {
            return httpError(
              "BAD_REQUEST",
              `Unknown agent "${body.agent}". Available: ${resolved.available.join(", ")}.`,
              400,
            );
          }
          // binary_not_found — `httpError` does not currently expose a
          // FAILED_DEPENDENCY (424) code, so surface as 400 with the
          // command + install hint inline so other clients of
          // POST /v1/acp/spawn see the same actionable text the LLM
          // tool surfaces.
          return httpError(
            "BAD_REQUEST",
            `${resolved.agent.command} is not on PATH. ${resolved.hint}`,
            400,
          );
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
      description: "Return all active ACP sessions.",
      tags: ["acp"],
      responseBody: z.object({
        sessions: z.array(z.unknown()).describe("ACP session status objects"),
      }),
      handler: () => {
        const manager = getAcpSessionManager();
        const sessions = manager.getStatus();
        return Response.json({ sessions });
      },
    },
  ];
}
