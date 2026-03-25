/**
 * Route handlers for ACP (Agent Communication Protocol) session lifecycle.
 *
 * Exposes spawn, steer, cancel, close, sessions, and permission operations
 * over HTTP.
 */
import {
  broadcastToAllClients,
  getAcpSessionManager,
} from "../../acp/index.js";
import { getConfig } from "../../config/loader.js";
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
      requestBody: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent name" },
          task: { type: "string", description: "Task description" },
          conversationId: { type: "string" },
          cwd: { type: "string", description: "Working directory" },
        },
        required: ["agent", "task", "conversationId"],
      },
      responseBody: {
        type: "object",
        properties: {
          acpSessionId: { type: "string" },
          protocolSessionId: { type: "string" },
          agent: { type: "string" },
        },
      },
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
        const config = getConfig();
        if (!config.acp.enabled) {
          return httpError("BAD_REQUEST", "ACP is not enabled", 400);
        }
        const agentConfig = config.acp.agents[body.agent];
        if (!agentConfig) {
          const available = Object.keys(config.acp.agents).join(", ") || "none";
          return httpError(
            "BAD_REQUEST",
            `Unknown agent "${body.agent}". Available: ${available}`,
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
          agentConfig,
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
      requestBody: {
        type: "object",
        properties: {
          instruction: { type: "string" },
        },
        required: ["instruction"],
      },
      responseBody: {
        type: "object",
        properties: {
          acpSessionId: { type: "string" },
          steered: { type: "boolean" },
        },
      },
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
      responseBody: {
        type: "object",
        properties: {
          acpSessionId: { type: "string" },
          cancelled: { type: "boolean" },
        },
      },
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
      responseBody: {
        type: "object",
        properties: {
          acpSessionId: { type: "string" },
          closed: { type: "boolean" },
        },
      },
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
      responseBody: {
        type: "object",
        properties: {
          sessions: {
            type: "array",
            description: "ACP session status objects",
          },
        },
      },
      handler: () => {
        const manager = getAcpSessionManager();
        const sessions = manager.getStatus();
        return Response.json({ sessions });
      },
    },
  ];
}
