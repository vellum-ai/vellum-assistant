import { reloadMcpServers } from "../mcp-reload-service.js";
import { defineHandlers } from "./shared.js";

export const mcpHandlers = defineHandlers({
  mcp_reload_request: async (_msg, socket, ctx) => {
    const result = await reloadMcpServers();
    ctx.send(socket, { type: "mcp_reload_response", ...result });
  },
});
