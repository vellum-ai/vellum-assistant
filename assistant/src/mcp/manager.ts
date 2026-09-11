import {
  MCP_GLOBAL_MAX_TOOLS,
  MCP_MAX_TOOLS_PER_SERVER,
  type ResolvedMcpConfig,
  type ResolvedMcpServerConfig,
} from "../config/schemas/mcp.js";
import { getLogger } from "../util/logger.js";
import { McpClient, type McpToolInfo } from "./client.js";

const log = getLogger("mcp-manager");

export interface McpServerToolInfo {
  serverId: string;
  serverConfig: ResolvedMcpServerConfig;
  tools: McpToolInfo[];
}

export type McpConnectionState =
  | "connecting"
  | "connected"
  | "needs-auth"
  | "error";

export class McpServerManager {
  private clients = new Map<string, McpClient>();
  private connectionStates = new Map<
    string,
    { source: ResolvedMcpServerConfig["source"]; state: McpConnectionState }
  >();

  async start(config: ResolvedMcpConfig): Promise<McpServerToolInfo[]> {
    const results: McpServerToolInfo[] = [];

    console.log(
      `[MCP] Starting ${Object.keys(config.servers).length} server(s)...`,
    );
    for (const [serverId, serverConfig] of Object.entries(config.servers)) {
      this.connectionStates.set(serverId, {
        source: serverConfig.source,
        state: "connecting",
      });
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
            "HTTP transport: OAuth provider will be available if server requires authentication",
          );
        }
        // The server's own origin decides whether it may resolve
        // `mcp:<serverId>:*` from the credential store.
        const client = new McpClient(serverId, serverConfig.source);
        await client.connect(serverConfig.transport);

        if (!client.isConnected) {
          this.connectionStates.set(serverId, {
            source: serverConfig.source,
            state: client.lastError ? "error" : "needs-auth",
          });
          continue;
        }

        this.clients.set(serverId, client);

        let tools = await client.listTools();
        log.info(
          { serverId, toolCount: tools.length },
          "MCP server tools discovered",
        );

        if (tools.length > MCP_MAX_TOOLS_PER_SERVER) {
          log.warn(
            {
              serverId,
              discovered: tools.length,
              max: MCP_MAX_TOOLS_PER_SERVER,
            },
            "MCP server exceeded per-server tool cap, truncating",
          );
          tools = tools.slice(0, MCP_MAX_TOOLS_PER_SERVER);
        }

        results.push({ serverId, serverConfig, tools });
        this.connectionStates.set(serverId, {
          source: serverConfig.source,
          state: "connected",
        });
      } catch (err) {
        this.connectionStates.set(serverId, {
          source: serverConfig.source,
          state: "error",
        });
        console.error(`[MCP] Failed to connect to server "${serverId}":`, err);
        log.error({ err, serverId }, "Failed to connect to MCP server");
        // Clean up any partially-connected client
        const staleClient = this.clients.get(serverId);
        if (staleClient) {
          try {
            await staleClient.disconnect();
          } catch {
            /* ignore */
          }
          this.clients.delete(serverId);
        }
      }
    }

    const totalTools = results.reduce((sum, r) => sum + r.tools.length, 0);
    if (totalTools > MCP_GLOBAL_MAX_TOOLS) {
      log.warn(
        { totalTools, globalMax: MCP_GLOBAL_MAX_TOOLS },
        "Total MCP tools exceed the global cap, truncating",
      );
      let remaining = MCP_GLOBAL_MAX_TOOLS;
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
    this.connectionStates.clear();
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

  getServerState(
    serverId: string,
    source: ResolvedMcpServerConfig["source"],
  ): McpConnectionState | undefined {
    const entry = this.connectionStates.get(serverId);
    if (entry?.source !== source) {
      return undefined;
    }
    if (
      entry.state === "connected" &&
      !this.clients.get(serverId)?.isConnected
    ) {
      return "error";
    }
    return entry.state;
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
  if (!instance) {
    return;
  }
  await instance.stop();
}
