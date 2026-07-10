/**
 * Shared MCP reload business logic.
 *
 * Called by the ConfigWatcher when config.json changes or a reload signal
 * file is detected, so the daemon automatically reconnects MCP servers.
 */

import { getConfig, invalidateConfigCache } from "../config/loader.js";
import { getMcpServerManager } from "../mcp/manager.js";
import { migrateLegacyMcpHeaders } from "../mcp/mcp-header-store.js";
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
  /** True when the server did not connect because it requires authentication. */
  needsAuth?: boolean;
  /** Transport-level failure message, when the server failed to connect. */
  error?: string;
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

    // 0. Migrate any legacy plaintext headers from config.json into
    //    the credential store before loading config for server startup.
    //    No-ops when no legacy headers remain; errors are logged, not thrown.
    try {
      await migrateLegacyMcpHeaders();
    } catch (err) {
      log.warn({ err }, "Legacy MCP header migration failed — continuing");
    }

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
      const infoById = new Map(
        serverToolInfos.map((info) => [info.serverId, info]),
      );
      // Preserve config order so callers see a stable server list.
      for (const id of serverIds) {
        const info = infoById.get(id);
        if (info) {
          const mcpTools = createMcpToolsFromServer(
            info.tools,
            id,
            info.serverConfig,
            manager,
          );
          const accepted = registerMcpTools(id, mcpTools);
          toolCount += accepted.length;
          servers.push({
            id,
            connected: true,
            toolCount: accepted.length,
            tools: accepted.map((t) => t.name),
          });
          continue;
        }
        const state = manager.getConnectionState(id);
        servers.push({
          id,
          connected: false,
          disabled: state?.status === "disabled" ? true : undefined,
          needsAuth: state?.status === "needs-auth" ? true : undefined,
          error: state?.status === "error" ? state.error : undefined,
          toolCount: 0,
          tools: [],
        });
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
