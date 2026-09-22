import { getConfig } from "../config/loader.js";
import type {
  ResolvedMcpConfig,
  ResolvedMcpServerConfig,
} from "../config/schemas/mcp.js";
import { getLogger } from "../util/logger.js";
import { McpClient, type McpToolInfo } from "./client.js";
import {
  applyMcpToolCaps,
  resolveMcpGlobalMaxTools,
  truncatedServerIdsFromCaps,
} from "./tool-caps.js";

const log = getLogger("mcp-manager");

export interface McpServerToolInfo {
  serverId: string;
  serverConfig: ResolvedMcpServerConfig;
  tools: McpToolInfo[];
}

export interface McpStartResult {
  servers: McpServerToolInfo[];
  configuredServerCount: number;
  connectedServerCount: number;
  errorServerCount: number;
  needsAuthServerCount: number;
  discoveredToolCount: number;
  keptToolCount: number;
  droppedToolCount: number;
  truncatedServerIds: string[];
}

export type McpConnectionState =
  | "connecting"
  | "connected"
  | "needs-auth"
  | "error";

export type McpUnexpectedCloseHandler = () => void;

export class McpServerManager {
  private clients = new Map<string, McpClient>();
  private connectionStates = new Map<
    string,
    { source: ResolvedMcpServerConfig["source"]; state: McpConnectionState }
  >();

  constructor(private onUnexpectedClose?: McpUnexpectedCloseHandler) {}

  setUnexpectedCloseHandler(handler: McpUnexpectedCloseHandler): void {
    this.onUnexpectedClose = handler;
  }

  async start(config: ResolvedMcpConfig): Promise<McpStartResult> {
    const entries = Object.entries(config.servers);
    log.info(
      { configuredServerCount: entries.length },
      "Starting configured MCP servers",
    );
    console.log(`[MCP] Starting ${entries.length} server(s)...`);

    const started = await Promise.all(
      entries.map(([serverId, serverConfig]) =>
        this.startOne(serverId, serverConfig),
      ),
    );
    const connected = started.filter(
      (result): result is McpServerToolInfo => result != null,
    );
    const errorServerCount = [...this.connectionStates.values()].filter(
      (entry) => entry.state === "error",
    ).length;
    const needsAuthServerCount = [...this.connectionStates.values()].filter(
      (entry) => entry.state === "needs-auth",
    ).length;

    const capped = applyMcpToolCaps(
      connected.map((result) => ({
        serverId: result.serverId,
        tools: result.tools,
      })),
      { globalMax: resolveMcpGlobalMaxTools(getConfig().tools) },
    );
    const keptByServer = new Map(
      capped.servers.map((server) => [server.serverId, server.tools]),
    );
    const results = connected.map((result) => ({
      ...result,
      tools: keptByServer.get(result.serverId) ?? [],
    }));
    const truncatedServerIds = truncatedServerIdsFromCaps(capped.decisions);

    if (capped.droppedToolCount > 0) {
      log.warn(
        {
          configuredServerCount: entries.length,
          connectedServerCount: connected.length,
          errorServerCount,
          needsAuthServerCount,
          discoveredToolCount: capped.discoveredToolCount,
          keptToolCount: capped.keptToolCount,
          droppedToolCount: capped.droppedToolCount,
          globalCap: capped.globalCap,
          perServerCap: capped.perServerCap,
          truncatedServerIds,
          decisions: capped.decisions.filter(
            (decision) =>
              decision.droppedByPerServerCap > 0 ||
              decision.droppedByGlobalCap > 0,
          ),
        },
        "MCP tool caps dropped tools using fair per-server selection",
      );
    } else {
      log.info(
        {
          configuredServerCount: entries.length,
          connectedServerCount: connected.length,
          errorServerCount,
          needsAuthServerCount,
          discoveredToolCount: capped.discoveredToolCount,
          keptToolCount: capped.keptToolCount,
          globalCap: capped.globalCap,
          perServerCap: capped.perServerCap,
        },
        "MCP servers connected",
      );
    }

    return {
      servers: results,
      configuredServerCount: entries.length,
      connectedServerCount: connected.length,
      errorServerCount,
      needsAuthServerCount,
      discoveredToolCount: capped.discoveredToolCount,
      keptToolCount: capped.keptToolCount,
      droppedToolCount: capped.droppedToolCount,
      truncatedServerIds,
    };
  }

  private async startOne(
    serverId: string,
    serverConfig: ResolvedMcpServerConfig,
  ): Promise<McpServerToolInfo | null> {
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
      const client = new McpClient(serverId, serverConfig, () => {
        if (this.clients.get(serverId) !== client) {
          return;
        }
        this.connectionStates.set(serverId, {
          source: serverConfig.source,
          state: "error",
        });
        this.onUnexpectedClose?.();
      });
      await client.connect(serverConfig.transport);

      if (!client.isConnected) {
        this.connectionStates.set(serverId, {
          source: serverConfig.source,
          state: client.lastError ? "error" : "needs-auth",
        });
        return null;
      }

      this.clients.set(serverId, client);

      const tools = await client.listTools();
      if (!client.isConnected || this.clients.get(serverId) !== client) {
        this.clients.delete(serverId);
        this.connectionStates.set(serverId, {
          source: serverConfig.source,
          state: "error",
        });
        return null;
      }
      log.info(
        { serverId, toolCount: tools.length },
        "MCP server tools discovered",
      );

      this.connectionStates.set(serverId, {
        source: serverConfig.source,
        state: "connected",
      });
      return { serverId, serverConfig, tools };
    } catch (err) {
      this.connectionStates.set(serverId, {
        source: serverConfig.source,
        state: "error",
      });
      console.error(`[MCP] Failed to connect to server "${serverId}":`, err);
      log.error({ err, serverId }, "Failed to connect to MCP server");
      const staleClient = this.clients.get(serverId);
      if (staleClient) {
        try {
          await staleClient.disconnect();
        } catch {
          /* ignore */
        }
        this.clients.delete(serverId);
      }
      return null;
    }
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
    return entry?.source === source ? entry.state : undefined;
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
