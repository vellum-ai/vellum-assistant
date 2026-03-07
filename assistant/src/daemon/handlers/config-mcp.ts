import { getConfig, invalidateConfigCache } from "../../config/loader.js";
import type { McpReloadServerResult } from "../../daemon/ipc-contract/settings.js";
import { getMcpServerManager } from "../../mcp/manager.js";
import { createMcpToolsFromServer } from "../../tools/mcp/mcp-tool-factory.js";
import {
  registerMcpTools,
  unregisterAllMcpTools,
} from "../../tools/registry.js";
import { defineHandlers, log } from "./shared.js";

export const mcpHandlers = defineHandlers({
  mcp_reload_request: async (_msg, socket, ctx) => {
    try {
      const manager = getMcpServerManager();

      // 1. Stop existing MCP servers + unregister their tools
      await manager.stop();
      unregisterAllMcpTools();

      // 2. Reload config from disk (picks up new tokens, added/removed servers)
      invalidateConfigCache();
      const config = getConfig();
      const serverIds = config.mcp?.servers
        ? Object.keys(config.mcp.servers)
        : [];

      // 3. Restart MCP servers
      let serverCount = 0;
      let toolCount = 0;
      const servers: McpReloadServerResult[] = [];

      if (config.mcp?.servers && Object.keys(config.mcp.servers).length > 0) {
        const serverToolInfos = await manager.start(config.mcp);
        for (const { serverId, serverConfig, tools } of serverToolInfos) {
          const toolNames = tools.map((t) => t.name);
          const mcpTools = createMcpToolsFromServer(
            tools,
            serverId,
            serverConfig,
            manager,
          );
          registerMcpTools(mcpTools);
          toolCount += mcpTools.length;
          servers.push({
            id: serverId,
            connected: tools.length > 0,
            toolCount: mcpTools.length,
            tools: toolNames,
          });
        }
        serverCount = serverToolInfos.length;

        // Include servers that were configured but failed to connect (not in serverToolInfos)
        for (const id of serverIds) {
          if (!servers.some((s) => s.id === id)) {
            servers.push({ id, connected: false, toolCount: 0, tools: [] });
          }
        }
      }

      // Sessions pick up new MCP tools automatically on their next turn
      // via the dynamic resolver in createResolveToolsCallback — no need
      // to evict sessions.

      ctx.send(socket, {
        type: "mcp_reload_response",
        success: true,
        serverCount,
        toolCount,
        servers,
      });
      log.info({ serverCount, toolCount }, "MCP servers reloaded");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      ctx.send(socket, {
        type: "mcp_reload_response",
        success: false,
        error,
      });
      log.error({ err }, "MCP reload failed");
    }
  },
});
