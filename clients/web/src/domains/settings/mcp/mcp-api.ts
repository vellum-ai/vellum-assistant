/**
 * Thin API layer for MCP server management.
 *
 * The daemon's internal/mcp/* routes are not yet in the generated SDK,
 * so this module calls them directly via the daemon client. The gateway
 * proxies them transparently via /v1/assistants/{id}/internal/mcp/*.
 */

import { client } from "@/generated/daemon/client.gen";

// ---------------------------------------------------------------------------
// Response shapes (mirror the daemon's responseBody Zod schemas)
// ---------------------------------------------------------------------------

interface McpServerTransport {
  type: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
}

export interface McpServerEntry {
  id: string;
  status: string;
  transport: McpServerTransport;
  enabled: boolean;
  defaultRiskLevel: string;
  hasOAuth: boolean;
  hasStaticAuth: boolean;
  authType: "none" | "bearer" | "api-key";
  authHeaderName?: string;
  allowedTools?: string[];
  blockedTools?: string[];
}

export interface McpToolEntry {
  name: string;
  description: string;
  estimatedTokens: number;
}

export interface McpToolsSummaryServer {
  serverId: string;
  toolCount: number;
  estimatedTokens: number;
  tools: McpToolEntry[];
}

interface McpListResponse {
  servers: McpServerEntry[];
}

interface McpToolsSummaryResponse {
  servers: McpToolsSummaryServer[];
  totalToolCount: number;
  totalEstimatedTokens: number;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export async function fetchMcpServers(
  assistantId: string,
): Promise<McpListResponse> {
  const { data, response } = await client.get({
    url: "/v1/assistants/{assistant_id}/internal/mcp/list" as "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
  });
  if (!response?.ok) {
    throw new Error(`Failed to fetch MCP servers: ${response?.status}`);
  }
  return data as unknown as McpListResponse;
}

export async function fetchMcpToolsSummary(
  assistantId: string,
): Promise<McpToolsSummaryResponse> {
  const { data, response } = await client.get({
    url: "/v1/assistants/{assistant_id}/internal/mcp/tools-summary" as "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
  });
  if (!response?.ok) {
    throw new Error(`Failed to fetch MCP tools summary: ${response?.status}`);
  }
  return data as unknown as McpToolsSummaryResponse;
}

export async function updateMcpServer(
  assistantId: string,
  body: {
    name: string;
    enabled?: boolean;
    defaultRiskLevel?: string;
    maxTools?: number;
    allowedTools?: string[] | null;
    blockedTools?: string[] | null;
    headers?: Record<string, string> | null;
  },
): Promise<void> {
  const { response } = await client.post({
    url: "/v1/assistants/{assistant_id}/internal/mcp/update" as "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
    body: body as Record<string, unknown>,
  });
  if (!response?.ok) {
    throw new Error(`Failed to update MCP server: ${response?.status}`);
  }
}

export async function addMcpServer(
  assistantId: string,
  body: {
    name: string;
    transportType: string;
    url?: string;
    command?: string;
    args?: string[];
    risk?: string;
    disabled?: boolean;
    headers?: Record<string, string>;
  },
): Promise<void> {
  const { response } = await client.post({
    url: "/v1/assistants/{assistant_id}/internal/mcp/add" as "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
    body: body as Record<string, unknown>,
  });
  if (!response?.ok) {
    throw new Error(`Failed to add MCP server: ${response?.status}`);
  }
}

export async function removeMcpServer(
  assistantId: string,
  name: string,
): Promise<void> {
  const { response } = await client.post({
    url: "/v1/assistants/{assistant_id}/internal/mcp/remove" as "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
    body: { name } as Record<string, unknown>,
  });
  if (!response?.ok) {
    throw new Error(`Failed to remove MCP server: ${response?.status}`);
  }
}

export async function startMcpAuth(
  assistantId: string,
  serverId: string,
): Promise<{ auth_url: string; state: string; already_authenticated?: boolean }> {
  const { data, response } = await client.post({
    url: "/v1/assistants/{assistant_id}/internal/mcp/auth/start" as "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
    body: { serverId } as Record<string, unknown>,
  });
  if (!response?.ok) {
    throw new Error(`Failed to start MCP auth: ${response?.status}`);
  }
  return data as unknown as { auth_url: string; state: string; already_authenticated?: boolean };
}

export async function pollMcpAuthStatus(
  assistantId: string,
  serverId: string,
): Promise<{ status: string; auth_url?: string; error?: string }> {
  const { data, response } = await client.get({
    url: `/v1/assistants/{assistant_id}/internal/mcp/auth/status/${encodeURIComponent(serverId)}` as "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
  });
  if (!response?.ok) {
    throw new Error(`Failed to poll MCP auth status: ${response?.status}`);
  }
  return data as unknown as { status: string; auth_url?: string; error?: string };
}

export async function revokeMcpOAuth(
  assistantId: string,
  serverId: string,
): Promise<void> {
  const { response } = await client.post({
    url: "/v1/assistants/{assistant_id}/internal/mcp/auth/revoke" as "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
    body: { serverId } as Record<string, unknown>,
  });
  if (!response?.ok) {
    throw new Error(`Failed to revoke OAuth for ${serverId}: ${response?.status}`);
  }
}

export async function reloadMcpServers(assistantId: string): Promise<void> {
  const { response } = await client.post({
    url: "/v1/assistants/{assistant_id}/internal/mcp/reload" as "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
    body: {} as Record<string, unknown>,
  });
  if (!response?.ok) {
    throw new Error(`Failed to reload MCP servers: ${response?.status}`);
  }
}
