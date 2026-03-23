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
    // POST /v1/acp/spawn
    {
      endpoint: "acp/spawn",
      method: "POST",
      policyKey: "acp/spawn",
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

    // POST /v1/acp/:id/steer
    {
      endpoint: "acp/:id/steer",
      method: "POST",
      policyKey: "acp/steer",
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

    // POST /v1/acp/:id/cancel
    {
      endpoint: "acp/:id/cancel",
      method: "POST",
      policyKey: "acp/cancel",
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

    // POST /v1/acp/:id/close
    {
      endpoint: "acp/:id/close",
      method: "POST",
      policyKey: "acp/close",
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

    // GET /v1/acp/sessions
    {
      endpoint: "acp/sessions",
      method: "GET",
      policyKey: "acp",
      handler: () => {
        const manager = getAcpSessionManager();
        const sessions = manager.getStatus();
        return Response.json({ sessions });
      },
    },
  ];
}
