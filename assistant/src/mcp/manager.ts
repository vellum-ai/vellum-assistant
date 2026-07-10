import type { McpConfig, McpServerConfig } from "../config/schemas/mcp.js";
import { getLogger } from "../util/logger.js";
import { McpClient, type McpToolInfo } from "./client.js";

const log = getLogger("mcp-manager");

export interface McpServerToolInfo {
  serverId: string;
  serverConfig: McpServerConfig;
  tools: McpToolInfo[];
}

/** Outcome of the most recent connection attempt for a server. */
export type McpServerConnectionState =
  | { status: "connected" }
  | { status: "needs-auth" }
  | { status: "error"; error: string }
  | { status: "disabled" };

export class McpServerManager {
  private clients = new Map<string, McpClient>();
  private serverConfigs = new Map<string, McpServerConfig>();
  private connectionStates = new Map<string, McpServerConnectionState>();

  async start(config: McpConfig): Promise<McpServerToolInfo[]> {
    const results: McpServerToolInfo[] = [];
    this.connectionStates.clear();

    console.log(
      `[MCP] Starting ${Object.keys(config.servers).length} server(s)...`,
    );
    for (const [serverId, serverConfig] of Object.entries(config.servers)) {
      if (!serverConfig.enabled) {
        console.log(`[MCP] Server "${serverId}" is disabled, skipping`);
        log.info({ serverId }, "MCP server disabled, skipping");
        this.connectionStates.set(serverId, { status: "disabled" });
        continue;
      }

      try {
        console.log(
          `[MCP] Starting server "${serverId}" (transport: ${serverConfig.transport.type})`,
        );
        if (
          serverConfig.transport.type === "sse" ||
          serverConfig.transport.type === "streamable-http"
        ) {
          log.debug(
            { serverId },
            "HTTP transport — OAuth provider will be available if server requires authentication",
          );
        }
        const client = new McpClient(serverId);
        await client.connect(serverConfig.transport);

        if (!client.isConnected) {
          // A recorded lastError means a transport failure; its absence means
          // the server requires authentication (connect() logged guidance).
          const err = client.lastError;
          this.connectionStates.set(
            serverId,
            err
              ? { status: "error", error: err.message }
              : { status: "needs-auth" },
          );
          continue;
        }

        this.clients.set(serverId, client);
        this.serverConfigs.set(serverId, serverConfig);
        this.connectionStates.set(serverId, { status: "connected" });

        let tools = await client.listTools();
        log.info(
          { serverId, toolCount: tools.length },
          "MCP server tools discovered",
        );

        // Apply tool filtering
        tools = this.filterTools(tools, serverConfig);

        // Apply per-server maxTools limit
        if (tools.length > serverConfig.maxTools) {
          log.warn(
            { serverId, discovered: tools.length, max: serverConfig.maxTools },
            "MCP server exceeded maxTools limit, truncating",
          );
          tools = tools.slice(0, serverConfig.maxTools);
        }

        results.push({ serverId, serverConfig, tools });
      } catch (err) {
        console.error(`[MCP] Failed to connect to server "${serverId}":`, err);
        log.error({ err, serverId }, "Failed to connect to MCP server");
        this.connectionStates.set(serverId, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        // Clean up any partially-connected client
        const staleClient = this.clients.get(serverId);
        if (staleClient) {
          try {
            await staleClient.disconnect();
          } catch {
            /* ignore */
          }
          this.clients.delete(serverId);
          this.serverConfigs.delete(serverId);
        }
      }
    }

    // Apply global max tools limit
    const totalTools = results.reduce((sum, r) => sum + r.tools.length, 0);
    if (totalTools > config.globalMaxTools) {
      log.warn(
        { totalTools, globalMax: config.globalMaxTools },
        "Total MCP tools exceed globalMaxTools, truncating",
      );
      let remaining = config.globalMaxTools;
      for (const result of results) {
        if (remaining <= 0) {
          result.tools = [];
        } else if (result.tools.length > remaining) {
          result.tools = result.tools.slice(0, remaining);
        }
        remaining -= result.tools.length;
      }
    }

    return results;
  }

  async stop(): Promise<void> {
    const disconnects = Array.from(this.clients.values()).map((client) =>
      client.disconnect().catch((err) => {
        log.warn(
          { err, serverId: client.serverId },
          "Error disconnecting MCP server",
        );
      }),
    );
    await Promise.all(disconnects);
    this.clients.clear();
    this.serverConfigs.clear();
    log.info("All MCP servers disconnected");
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`MCP server "${serverId}" not found`);
    }
    return client.callTool(toolName, args, signal);
  }

  getClient(serverId: string): McpClient | undefined {
    return this.clients.get(serverId);
  }

  /** True when the manager holds a live, connected client for the server. */
  isServerConnected(serverId: string): boolean {
    return this.clients.get(serverId)?.isConnected ?? false;
  }

  /**
   * Outcome of the most recent connection attempt for the server, or undefined
   * when the server was not part of the last start() cycle.
   */
  getConnectionState(serverId: string): McpServerConnectionState | undefined {
    return this.connectionStates.get(serverId);
  }

  private filterTools(
    tools: McpToolInfo[],
    config: McpServerConfig,
  ): McpToolInfo[] {
    let filtered = tools;

    if (config.allowedTools) {
      const allowed = new Set(config.allowedTools);
      filtered = filtered.filter((t) => allowed.has(t.name));
    }

    if (config.blockedTools) {
      const blocked = new Set(config.blockedTools);
      filtered = filtered.filter((t) => !blocked.has(t.name));
    }

    return filtered;
  }
}

// Singleton instance
let instance: McpServerManager | null = null;

export function getMcpServerManager(): McpServerManager {
  if (!instance) {
    instance = new McpServerManager();
  }
  return instance;
}

/**
 * Stop the MCP server manager singleton (disconnect all servers) if one was
 * created. No-op when no manager exists — e.g. no MCP servers were ever
 * configured — so shutdown callers don't need to gate on configuration. Acts on
 * the live singleton, so it also stops servers added at runtime via MCP reload.
 */
export async function stopMcpServerManager(): Promise<void> {
  if (!instance) return;
  await instance.stop();
}
