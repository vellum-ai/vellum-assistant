/**
 * Internal routes for daemon-owned MCP management.
 *
 * POST internal/mcp/auth/start   — kicks off the OAuth flow in the daemon
 *                                  and returns the authorization URL
 * GET  internal/mcp/auth/status/:serverId — polls current flow status
 * POST internal/mcp/reload       — trigger MCP server reload
 * GET  internal/mcp/list         — list servers with health status
 * POST internal/mcp/add          — add a new MCP server config
 * POST internal/mcp/remove       — remove an MCP server config + credentials
 */

import { z } from "zod";

import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import type { McpConfig, McpServerConfig } from "../../config/schemas/mcp.js";
import { reloadMcpServers } from "../../daemon/mcp-reload-service.js";
import { McpClient } from "../../mcp/client.js";
import { orchestrateMcpOAuthConnect } from "../../mcp/mcp-auth-orchestrator.js";
import { getMcpAuthState } from "../../mcp/mcp-auth-state.js";
import { deleteMcpOAuthCredentials } from "../../mcp/mcp-oauth-provider.js";
import { getLogger } from "../../util/logger.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("mcp-auth-routes");

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

/**
 * Fire-and-forget MCP reload. reloadMcpServers() has its own
 * reloadInProgress mutex, so concurrent calls coalesce.
 */
function triggerReload(context: string): void {
  void reloadMcpServers().catch((err) => {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      `${context} background reload failed`,
    );
  });
}

function handleMcpReload(_args: {
  body?: Record<string, unknown>;
}): { ok: true } {
  triggerReload("internal_mcp_reload");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Health check helper
// ---------------------------------------------------------------------------

const HEALTH_CHECK_TIMEOUT_MS = 10_000;

async function checkServerHealth(
  serverId: string,
  config: McpServerConfig,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<string> {
  const client = new McpClient(serverId);
  try {
    await Promise.race([
      client.connect(config.transport),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        if (typeof t === "object" && "unref" in t) t.unref();
      }),
    ]);

    if (client.isConnected) {
      await client.disconnect();
      return "✓ Connected";
    }

    const err = client.lastError;
    if (err) {
      const message = err.message;
      if (message.includes("timeout")) {
        return "✗ Timed out";
      }
      return `✗ Error: ${message}`;
    }

    return "! Needs authentication";
  } catch (err) {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("timeout")) {
      return "✗ Timed out";
    }
    return `✗ Error: ${message}`;
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

interface McpServerEntry {
  id: string;
  status: string;
  transport: McpServerConfig["transport"];
  enabled: boolean;
  defaultRiskLevel: string;
  allowedTools?: string[];
  blockedTools?: string[];
}

async function handleMcpList(_args: {
  body?: Record<string, unknown>;
}): Promise<{ servers: McpServerEntry[] }> {
  const raw = loadRawConfig();
  const mcpConfig = raw.mcp as Partial<McpConfig> | undefined;
  const servers = mcpConfig?.servers ?? {};
  const entries = Object.entries(servers) as [string, McpServerConfig][];

  const results: McpServerEntry[] = await Promise.all(
    entries
      .filter(([, config]) => config && typeof config === "object")
      .map(async ([id, config]) => {
        const enabled = config.enabled !== false;
        let status: string;
        if (!enabled) {
          status = "✗ disabled";
        } else {
          status = await checkServerHealth(id, config);
        }
        return {
          id,
          status,
          transport: config.transport,
          enabled,
          defaultRiskLevel: config.defaultRiskLevel ?? "high",
          ...(config.allowedTools && { allowedTools: config.allowedTools }),
          ...(config.blockedTools && { blockedTools: config.blockedTools }),
        };
      }),
  );

  return { servers: results };
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

async function handleMcpAdd({
  body,
}: {
  body?: Record<string, unknown>;
}): Promise<{ added: true }> {
  const {
    name,
    transportType,
    url,
    command,
    args,
    risk,
    disabled,
  } = body as {
    name: string;
    transportType: string;
    url?: string;
    command?: string;
    args?: string[];
    risk?: string;
    disabled?: boolean;
  };

  const riskLevel = risk ?? "high";
  if (!["low", "medium", "high"].includes(riskLevel)) {
    throw new BadRequestError(
      `Invalid risk level: ${riskLevel}. Must be low, medium, or high`,
    );
  }

  let transport: Record<string, unknown>;
  switch (transportType) {
    case "stdio":
      if (!command) {
        throw new BadRequestError("--command is required for stdio transport");
      }
      transport = { type: "stdio", command, args: args ?? [] };
      break;
    case "sse":
    case "streamable-http":
      if (!url) {
        throw new BadRequestError(
          `--url is required for ${transportType} transport`,
        );
      }
      transport = { type: transportType, url };
      break;
    default:
      throw new BadRequestError(
        `Unknown transport type: ${transportType}. Must be stdio, sse, or streamable-http`,
      );
  }

  const raw = loadRawConfig();
  if (!raw.mcp) raw.mcp = { servers: {} };
  const mcpConfig = raw.mcp as Record<string, unknown>;
  if (!mcpConfig.servers) mcpConfig.servers = {};
  const serverMap = mcpConfig.servers as Record<string, unknown>;

  if (serverMap[name]) {
    throw new BadRequestError(
      `MCP server "${name}" already exists. Remove it first with: assistant mcp remove ${name}`,
    );
  }

  serverMap[name] = {
    transport,
    enabled: !disabled,
    defaultRiskLevel: riskLevel,
  };

  saveRawConfig(raw);
  triggerReload("internal_mcp_add");

  return { added: true };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

async function handleMcpRemove({
  body,
}: {
  body?: Record<string, unknown>;
}): Promise<{ removed: true }> {
  const { name } = body as { name: string };

  const raw = loadRawConfig();
  const mcpConfig = raw.mcp as Record<string, unknown> | undefined;
  const serverMap = mcpConfig?.servers as Record<string, unknown> | undefined;

  if (!serverMap || !serverMap[name]) {
    throw new NotFoundError(`MCP server "${name}" not found.`);
  }

  // Best-effort cleanup of any OAuth credentials stored for this server
  const serverConfig = serverMap[name] as Record<string, unknown>;
  const transport = serverConfig?.transport as
    | Record<string, unknown>
    | undefined;
  if (transport?.type === "sse" || transport?.type === "streamable-http") {
    try {
      await deleteMcpOAuthCredentials(name);
    } catch {
      // Ignore — credentials may not exist
    }
  }

  delete serverMap[name];
  saveRawConfig(raw);
  triggerReload("internal_mcp_remove");

  return { removed: true };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "internal_mcp_auth_start",
    endpoint: "internal/mcp/auth/start",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
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
  {
    operationId: "internal_mcp_reload",
    endpoint: "internal/mcp/reload",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Trigger MCP server reload",
    description:
      "Kicks off reloadMcpServers() async on the daemon. Returns immediately.",
    tags: ["internal"],
    handler: handleMcpReload,
  },
  {
    operationId: "internal_mcp_list",
    endpoint: "internal/mcp/list",
    method: "GET",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "List MCP servers with health status",
    description:
      "Returns configured MCP servers with live health-check results (connected, needs auth, error, disabled).",
    tags: ["internal"],
    handler: handleMcpList,
  },
  {
    operationId: "internal_mcp_add",
    endpoint: "internal/mcp/add",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Add an MCP server configuration",
    description:
      "Writes a new MCP server entry to config.json and triggers a reload.",
    tags: ["internal"],
    requestBody: z.object({
      name: z.string(),
      transportType: z.string(),
      url: z.string().optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      risk: z.string().optional(),
      disabled: z.boolean().optional(),
    }),
    handler: handleMcpAdd,
  },
  {
    operationId: "internal_mcp_remove",
    endpoint: "internal/mcp/remove",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Remove an MCP server configuration",
    description:
      "Removes an MCP server from config.json, cleans up OAuth credentials, and triggers a reload.",
    tags: ["internal"],
    requestBody: z.object({ name: z.string() }),
    handler: handleMcpRemove,
  },
];
