export const mcpQueryKeys = {
  catalog: (assistantId: string) => ["mcp-catalog", assistantId] as const,
  auth: (assistantId: string, operationId: string) =>
    ["mcp-auth", assistantId, operationId] as const,
  list: (assistantId: string) => ["mcp-servers", assistantId] as const,
  details: (assistantId: string) => ["mcp-tools-summary", assistantId] as const,
};
