/**
 * Code-owned MCP tool-count caps and the selection used when they bind.
 *
 * The shipped global cap is {@link MCP_GLOBAL_MAX_TOOLS}. A workspace may
 * raise or lower it with `tools.mcpGlobalMaxTools` in config.json. The
 * per-server cap stays code-owned. These numbers are a context-window
 * budget, not a permission gate. Allowlists and risk still decide what
 * a turn may call.
 *
 * The global cap is applied by a deterministic round-robin across
 * servers sorted by id. Insertion order must not empty a later server
 * while earlier ones keep every tool.
 */

import {
  MCP_GLOBAL_MAX_TOOLS,
  MCP_MAX_TOOLS_PER_SERVER,
} from "../config/schemas/mcp.js";
import type { ToolsConfig } from "../config/schemas/tools.js";

export interface McpServerToolSet<T> {
  serverId: string;
  tools: readonly T[];
}

export interface McpToolCapDecision {
  serverId: string;
  discovered: number;
  kept: number;
  droppedByPerServerCap: number;
  droppedByGlobalCap: number;
}

export interface McpToolCapResult<T> {
  servers: Array<{ serverId: string; tools: T[] }>;
  discoveredToolCount: number;
  keptToolCount: number;
  droppedToolCount: number;
  globalCap: number;
  perServerCap: number;
  decisions: McpToolCapDecision[];
}

export function resolveMcpGlobalMaxTools(
  tools?: Pick<ToolsConfig, "mcpGlobalMaxTools">,
): number {
  return tools?.mcpGlobalMaxTools ?? MCP_GLOBAL_MAX_TOOLS;
}

export function applyMcpToolCaps<T>(
  servers: ReadonlyArray<McpServerToolSet<T>>,
  options?: { globalMax?: number; perServerMax?: number },
): McpToolCapResult<T> {
  const globalCap = options?.globalMax ?? MCP_GLOBAL_MAX_TOOLS;
  const perServerCap = options?.perServerMax ?? MCP_MAX_TOOLS_PER_SERVER;
  const discoveredToolCount = servers.reduce(
    (sum, server) => sum + server.tools.length,
    0,
  );

  const afterPerServer = servers.map((server) => {
    const droppedByPerServerCap = Math.max(
      0,
      server.tools.length - perServerCap,
    );
    return {
      serverId: server.serverId,
      tools: server.tools.slice(0, perServerCap),
      discovered: server.tools.length,
      droppedByPerServerCap,
    };
  });

  const afterPerServerCount = afterPerServer.reduce(
    (sum, server) => sum + server.tools.length,
    0,
  );
  if (afterPerServerCount <= globalCap) {
    const decisions = afterPerServer.map((server) => ({
      serverId: server.serverId,
      discovered: server.discovered,
      kept: server.tools.length,
      droppedByPerServerCap: server.droppedByPerServerCap,
      droppedByGlobalCap: 0,
    }));
    return {
      servers: afterPerServer.map((server) => ({
        serverId: server.serverId,
        tools: [...server.tools],
      })),
      discoveredToolCount,
      keptToolCount: afterPerServerCount,
      droppedToolCount: discoveredToolCount - afterPerServerCount,
      globalCap,
      perServerCap,
      decisions,
    };
  }

  const order = [...afterPerServer].sort((a, b) =>
    a.serverId.localeCompare(b.serverId),
  );
  const selected = new Map<string, T[]>(
    order.map((server) => [server.serverId, []]),
  );
  const cursors = new Map<string, number>(
    order.map((server) => [server.serverId, 0]),
  );
  let kept = 0;
  let progressed = true;
  while (kept < globalCap && progressed) {
    progressed = false;
    for (const server of order) {
      if (kept >= globalCap) {
        break;
      }
      const cursor = cursors.get(server.serverId) ?? 0;
      const tool = server.tools[cursor];
      if (tool !== undefined) {
        selected.get(server.serverId)?.push(tool);
        cursors.set(server.serverId, cursor + 1);
        kept += 1;
        progressed = true;
      }
    }
  }

  const decisions = afterPerServer.map((server) => {
    const keptTools = selected.get(server.serverId) ?? [];
    return {
      serverId: server.serverId,
      discovered: server.discovered,
      kept: keptTools.length,
      droppedByPerServerCap: server.droppedByPerServerCap,
      droppedByGlobalCap: server.tools.length - keptTools.length,
    };
  });

  return {
    servers: afterPerServer.map((server) => ({
      serverId: server.serverId,
      tools: [...(selected.get(server.serverId) ?? [])],
    })),
    discoveredToolCount,
    keptToolCount: kept,
    droppedToolCount: discoveredToolCount - kept,
    globalCap,
    perServerCap,
    decisions,
  };
}

export interface McpStartupSnapshot {
  configuredServerCount: number;
  connectedServerCount: number;
  discoveredToolCount: number;
  registeredToolCount: number;
  droppedToolCount: number;
  truncatedServerIds: string[];
  errorServerCount: number;
  needsAuthServerCount: number;
}

export const EMPTY_MCP_STARTUP_SNAPSHOT: McpStartupSnapshot = {
  configuredServerCount: 0,
  connectedServerCount: 0,
  discoveredToolCount: 0,
  registeredToolCount: 0,
  droppedToolCount: 0,
  truncatedServerIds: [],
  errorServerCount: 0,
  needsAuthServerCount: 0,
};

export function truncatedServerIdsFromCaps(
  decisions: readonly McpToolCapDecision[],
): string[] {
  return decisions
    .filter(
      (decision) =>
        decision.droppedByPerServerCap > 0 || decision.droppedByGlobalCap > 0,
    )
    .map((decision) => decision.serverId);
}
