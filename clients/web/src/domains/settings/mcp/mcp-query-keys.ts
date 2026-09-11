export const mcpQueryKeys = {
  list: (assistantId: string) => ["mcp-servers", assistantId] as const,
  details: (assistantId: string) => ["mcp-tools-summary", assistantId] as const,
};
