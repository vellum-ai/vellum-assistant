import { client } from "@/generated/daemon/client.gen";

export interface McpCatalogEntry {
  id: string;
  serverKey: string;
  definitionDigest: string;
  displayName: string;
  description: string;
  documentationUrl: string;
  verifiedAt: string;
  verification: "documentation-only" | "tested";
  setup: { mode: "oauth" | "manual"; instructions?: string };
  oauthProvider?: string;
  icon?: string;
  documents: {
    plugin: Record<string, unknown>;
    mcp?: {
      mcpServers?: Record<string, { type?: string; url?: string }>;
      [key: string]: unknown;
    };
  };
}

export interface McpCatalogResponse {
  supportsConnect: boolean;
  entries: McpCatalogEntry[];
}

export async function fetchMcpCatalog(assistantId: string): Promise<McpCatalogResponse> {
  const { data, response } = await client.get({
    url: "/v1/assistants/{assistant_id}/internal/mcp/catalog" as "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
  });
  if (response?.status === 404) {
    return { supportsConnect: false, entries: [] };
  }
  if (!response?.ok) {
    throw new Error(`Failed to fetch integrations: ${response?.status}`);
  }
  const catalog = data as unknown as Partial<McpCatalogResponse>;
  if (!catalog || !Array.isArray(catalog.entries)) {
    throw new Error("Invalid integration catalog response");
  }
  return { supportsConnect: catalog.supportsConnect === true, entries: catalog.entries };
}

export interface McpCatalogConnectRequest {
  catalogId: string;
  serverKey: string;
  definitionDigest: string;
  setupAcknowledged?: boolean;
}

export async function connectMcpCatalogEntry(
  assistantId: string,
  body: McpCatalogConnectRequest,
): Promise<{ serverId: string; created: boolean }> {
  const { data, response } = await client.post({
    url: "/v1/assistants/{assistant_id}/internal/mcp/catalog/connect" as "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
    body: { ...body },
  });
  if (!response?.ok) {
    throw new Error(`Failed to connect integration: ${response?.status}`);
  }
  const result = data as unknown as { serverId?: unknown; created?: unknown };
  if (!result || typeof result.serverId !== "string" || typeof result.created !== "boolean") {
    throw new Error("Invalid integration connection response");
  }
  return { serverId: result.serverId, created: result.created };
}
