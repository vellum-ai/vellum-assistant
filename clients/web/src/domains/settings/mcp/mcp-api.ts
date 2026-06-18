/**
 * Thin API layer for MCP server management.
 *
 * The daemon's internal/mcp/* routes are excluded from the generated SDK
 * (they use GATEWAY_PRINCIPALS policy), but the gateway proxies them
 * transparently when called via /v1/assistants/{id}/internal/mcp/*.
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
