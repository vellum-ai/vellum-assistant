import type { QueryClient } from "@tanstack/react-query";

export const mcpQueryKeys = {
  catalog: (assistantId: string) => ["mcp-catalog", assistantId] as const,
  auth: (assistantId: string, operationId: string) =>
    ["mcp-auth", assistantId, operationId] as const,
  list: (assistantId: string) => ["mcp-servers", assistantId] as const,
  details: (assistantId: string) => ["mcp-tools-summary", assistantId] as const,
};

/** Marks MCP caches stale while refetching only visible, enabled queries. */
export function invalidateMcpQueries(
  queryClient: QueryClient,
  assistantId: string,
  refetchType: "active" | "none" = "active",
): void {
  for (const queryKey of [
    mcpQueryKeys.list(assistantId),
    mcpQueryKeys.details(assistantId),
  ]) {
    void queryClient.invalidateQueries({ queryKey, refetchType });
  }
}
