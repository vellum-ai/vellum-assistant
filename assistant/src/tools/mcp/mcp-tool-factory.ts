import type { McpServerConfig } from "../../config/schemas/mcp.js";
import type { McpServerManager } from "../../mcp/manager.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { schemaDefinesProperty } from "../schema-transforms.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const riskMap: Record<string, RiskLevel> = {
  low: RiskLevel.Low,
  medium: RiskLevel.Medium,
  high: RiskLevel.High,
};

/**
 * Create a namespaced tool name to prevent collisions across MCP servers
 * and with core/skill tools.
 */
function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

export interface McpToolMetadata {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Create a Tool object from MCP tool metadata.
 * The tool delegates execution to the McpServerManager.
 */
export function createMcpTool(
  metadata: McpToolMetadata,
  serverId: string,
  serverConfig: McpServerConfig,
  manager: McpServerManager,
): Tool {
  const namespacedName = mcpToolName(serverId, metadata.name);
  const riskLevel = riskMap[serverConfig.defaultRiskLevel] ?? RiskLevel.High;
  const serverDefinesActivity = schemaDefinesProperty(
    metadata.inputSchema,
    "activity",
    { refBehavior: "assume-defined" },
  );

  return {
    name: namespacedName,
    description: metadata.description,
    category: "mcp",
    defaultRiskLevel: riskLevel,
    origin: "mcp",
    ownerMcpServerId: serverId,
    executionTarget: "host",

    getDefinition(): ToolDefinition {
      return {
        name: namespacedName,
        description: metadata.description,
        input_schema: metadata.inputSchema as ToolDefinition["input_schema"],
      };
    },

    async execute(
      input: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolExecutionResult> {
      try {
        // Strip injected activity before sending to MCP server
        const { activity: _activity, ...mcpInput } = input as Record<
          string,
          unknown
        > & {
          activity?: unknown;
        };
        const forwardInput = serverDefinesActivity ? input : mcpInput;
        const result = await manager.callTool(
          serverId,
          metadata.name,
          forwardInput,
          context.signal,
        );
        return {
          content: result.content,
          isError: result.isError,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `MCP tool execution failed: ${message}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * Create Tool objects from all tools provided by an MCP server.
 */
export function createMcpToolsFromServer(
  tools: McpToolMetadata[],
  serverId: string,
  serverConfig: McpServerConfig,
  manager: McpServerManager,
): Tool[] {
  return tools.map((tool) =>
    createMcpTool(tool, serverId, serverConfig, manager),
  );
}
