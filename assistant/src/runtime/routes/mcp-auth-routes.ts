/**
 * Internal routes for daemon-owned MCP OAuth flows.
 *
 * POST internal/mcp/auth/start   — kicks off the OAuth flow in the daemon
 *                                  and returns the authorization URL
 * GET  internal/mcp/auth/status/:serverId — polls current flow status
 */

import { z } from "zod";

import { loadRawConfig } from "../../config/loader.js";
import type { McpConfig } from "../../config/schemas/mcp.js";
import { orchestrateMcpOAuthConnect } from "../../mcp/mcp-auth-orchestrator.js";
import { getMcpAuthState } from "../../mcp/mcp-auth-state.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

async function handleMcpAuthStart({
  body,
}: {
  body?: Record<string, unknown>;
}): Promise<{ auth_url: string; state: string; already_authenticated?: boolean }> {
  const { serverId } = body as { serverId: string };

  const raw = loadRawConfig();
  const servers =
    (raw.mcp as Partial<McpConfig> | undefined)?.servers ?? {};
  const serverConfig = servers[serverId];

  if (!serverConfig) {
    throw new BadRequestError(`MCP server "${serverId}" not configured`);
  }

  const transport = serverConfig.transport;
  if (transport.type !== "sse" && transport.type !== "streamable-http") {
    throw new BadRequestError(
      `OAuth only supported for sse/streamable-http transports (server "${serverId}" uses ${transport.type})`,
    );
  }

  let result: { auth_url: string; already_authenticated?: boolean };
  try {
    result = await orchestrateMcpOAuthConnect({
      serverId,
      transport: {
        url: transport.url,
        type: transport.type,
        headers: transport.headers,
      },
    });
  } catch (err) {
    throw new InternalError(err instanceof Error ? err.message : String(err));
  }

  return { auth_url: result.auth_url, state: serverId, already_authenticated: result.already_authenticated };
}

function handleMcpAuthStatus({
  pathParams,
}: {
  pathParams?: Record<string, string>;
}):
  | { status: "pending"; auth_url: string }
  | { status: "complete" }
  | { status: "error"; error: string } {
  const { serverId } = pathParams as { serverId: string };
  const state = getMcpAuthState(serverId);

  if (state === null) {
    throw new NotFoundError(`No active OAuth flow for server "${serverId}"`);
  }

  if (state.status === "pending") return { status: "pending", auth_url: state.authUrl };
  if (state.status === "complete") return { status: "complete" };
  return { status: "error", error: state.error };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "internal_mcp_auth_start",
    endpoint: "internal/mcp/auth/start",
    method: "POST",
    summary: "Start MCP OAuth flow",
    description:
      "Starts a daemon-owned MCP OAuth flow and returns the authorization URL for the CLI to open in the browser.",
    tags: ["internal"],
    requestBody: z.object({ serverId: z.string() }),
    handler: handleMcpAuthStart,
  },
  {
    operationId: "internal_mcp_auth_status",
    endpoint: "internal/mcp/auth/status/:serverId",
    method: "GET",
    summary: "Poll MCP OAuth flow status",
    description:
      "Returns the current status of an in-flight MCP OAuth flow (pending/complete/error).",
    tags: ["internal"],
    pathParams: [{ name: "serverId" }],
    additionalResponses: {
      "404": { description: "No active OAuth flow for the given serverId" },
    },
    handler: handleMcpAuthStatus,
  },
];
