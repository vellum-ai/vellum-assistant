/**
 * Shared MCP reload business logic.
 *
 * Used by both the IPC handler (`config-mcp.ts`) and the HTTP route
 * (`runtime/routes/mcp-routes.ts`) so the reload behaviour is defined
 * in exactly one place.
 */

import { getConfig, invalidateConfigCache } from "../config/loader.js";
import type { McpReloadServerResult } from "../daemon/ipc-contract/settings.js";
import { getMcpServerManager } from "../mcp/manager.js";
import { createMcpToolsFromServer } from "../tools/mcp/mcp-tool-factory.js";
import { registerMcpTools, unregisterAllMcpTools } from "../tools/registry.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("mcp-reload-service");

export interface McpReloadResult {
  success: boolean;
  serverCount?: number;
  toolCount?: number;
  servers?: McpReloadServerResult[];
  error?: string;
}

/**
 * Stop all MCP servers, reload configuration from disk, and restart
 * servers with the updated config. Returns a summary of the reload.
 */
export async function reloadMcpServers(): Promise<McpReloadResult> {
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
      // Include servers that were configured but failed to connect (not in serverToolInfos)
      for (const id of serverIds) {
        if (!servers.some((s) => s.id === id)) {
          servers.push({ id, connected: false, toolCount: 0, tools: [] });
        }
      }
      serverCount = servers.length;
    }

    // Sessions pick up new MCP tools automatically on their next turn
    // via the dynamic resolver in createResolveToolsCallback — no need
    // to evict sessions.

    log.info({ serverCount, toolCount }, "MCP servers reloaded");
    return { success: true, serverCount, toolCount, servers };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err }, "MCP reload failed");
    return { success: false, error };
  }
}
