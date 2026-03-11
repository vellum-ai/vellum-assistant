/**
 * Shared MCP reload business logic.
 *
 * Used by the HTTP route (`runtime/routes/mcp-routes.ts`) so the reload
 * behaviour is defined in exactly one place.
 */

import { getConfig, invalidateConfigCache } from "../config/loader.js";
import { getMcpServerManager } from "../mcp/manager.js";
import { createMcpToolsFromServer } from "../tools/mcp/mcp-tool-factory.js";
import { registerMcpTools, unregisterAllMcpTools } from "../tools/registry.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("mcp-reload-service");

/** Per-server reload result. */
export interface McpReloadServerResult {
  id: string;
  connected: boolean;
  /** True when the server is explicitly disabled in config. */
  disabled?: boolean;
  toolCount: number;
  tools: string[];
}

export interface McpReloadResult {
  success: boolean;
  serverCount?: number;
  toolCount?: number;
  servers?: McpReloadServerResult[];
  error?: string;
}

let reloadInProgress: Promise<McpReloadResult> | null = null;

/**
 * Stop all MCP servers, reload configuration from disk, and restart
 * servers with the updated config. Returns a summary of the reload.
 *
 * Concurrent calls are serialized — if a reload is already in progress
 * the caller receives the same promise instead of starting a second one.
 */
export function reloadMcpServers(): Promise<McpReloadResult> {
  if (reloadInProgress) {
    log.info("MCP reload already in progress, awaiting existing operation");
    return reloadInProgress;
  }
  reloadInProgress = doReload().finally(() => {
    reloadInProgress = null;
  });
  return reloadInProgress;
}

async function doReload(): Promise<McpReloadResult> {
  try {
    const manager = getMcpServerManager();

    // 1. Validate new config before tearing down existing servers.
    //    If the config is broken we abort early, preserving the current
    //    working MCP setup instead of leaving zero servers.
    invalidateConfigCache();
    const config = getConfig();

    // 2. Stop existing MCP servers + unregister their tools
    await manager.stop();
    unregisterAllMcpTools();
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
        const mcpTools = createMcpToolsFromServer(
          tools,
          serverId,
          serverConfig,
          manager,
        );
        const accepted = registerMcpTools(mcpTools);
        const acceptedNames = accepted.map((t) => t.name);
        toolCount += accepted.length;
        servers.push({
          id: serverId,
          connected: true,
          toolCount: accepted.length,
          tools: acceptedNames,
        });
      }
      // Include servers that were configured but failed to connect or are disabled
      for (const id of serverIds) {
        if (!servers.some((s) => s.id === id)) {
          const serverConfig = config.mcp!.servers![id];
          const isDisabled = serverConfig?.enabled === false;
          servers.push({
            id,
            connected: false,
            disabled: isDisabled || undefined,
            toolCount: 0,
            tools: [],
          });
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
