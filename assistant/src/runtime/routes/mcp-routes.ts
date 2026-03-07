/**
 * HTTP routes for MCP server management.
 */

import { reloadMcpServers } from "../../daemon/mcp-reload-service.js";
import type { RouteDefinition } from "../http-router.js";

export function mcpRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "mcp/reload",
      method: "POST",
      handler: async () => {
        const result = await reloadMcpServers();
        const status = result.success ? 200 : 500;
        return Response.json(result, { status });
      },
    },
  ];
}
