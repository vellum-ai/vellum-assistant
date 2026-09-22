import {
  mcpSourceRiskLevel,
  type ResolvedMcpServerConfig,
} from "../../config/schemas/mcp.js";
import type { McpToolAnnotations } from "../../mcp/client.js";
import type { McpServerManager } from "../../mcp/manager.js";
import { RiskLevel } from "../../permissions/types.js";
import { toProviderSafeToolName } from "../provider-tool-name.js";
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
  return toProviderSafeToolName(`mcp__${serverId}__${toolName}`);
}

export interface McpToolMetadata {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

/** Risk levels ordered low to high, so a hint can step one place along it. */
const RISK_LADDER: readonly RiskLevel[] = [
  RiskLevel.Low,
  RiskLevel.Medium,
  RiskLevel.High,
];

function stepRisk(risk: RiskLevel, direction: -1 | 1): RiskLevel {
  const index = RISK_LADDER.indexOf(risk);
  if (index === -1) {
    return risk;
  }
  const next = Math.min(Math.max(index + direction, 0), RISK_LADDER.length - 1);
  return RISK_LADDER[next] ?? risk;
}

/**
 * Resolve the risk level a tool carries.
 *
 * The server's origin is the anchor, and a tool's own MCP annotations
 * move it at most one step along {@link RISK_LADDER}. Workspace servers
 * start at medium. Plugin servers start at low.
 *
 * `destructiveHint` steps up. Raising is the safe direction, so it applies
 * at any origin level.
 *
 * `readOnlyHint` steps down, and only from {@link RiskLevel.Medium}. A
 * workspace server can therefore step to low. A plugin server is already
 * at low, so the hint is a no-op. High is the floor for downward hints:
 * a tool already raised by `destructiveHint` stays raised.
 *
 * `destructiveHint` wins when a server sends both, since a tool that both
 * reads and destroys is a tool that destroys.
 *
 * The MCP spec defaults `destructiveHint` to true when it is absent. This
 * deliberately does not, because the origin already answers that question
 * for unlabeled tools. Honoring the spec default instead would put every
 * tool of every unannotated server back at High.
 */
function resolveRiskLevel(
  metadata: McpToolMetadata,
  serverConfig: ResolvedMcpServerConfig,
): RiskLevel {
  const serverRisk = riskMap[mcpSourceRiskLevel(serverConfig.source)];
  const annotations = metadata.annotations;
  if (annotations?.destructiveHint === true) {
    return stepRisk(serverRisk, 1);
  }
  if (annotations?.readOnlyHint === true && serverRisk === RiskLevel.Medium) {
    return stepRisk(serverRisk, -1);
  }
  return serverRisk;
}

/**
 * Create a Tool object from MCP tool metadata.
 * The tool delegates execution to the McpServerManager.
 */
export function createMcpTool(
  metadata: McpToolMetadata,
  serverId: string,
  serverConfig: ResolvedMcpServerConfig,
  manager: McpServerManager,
): Tool {
  const namespacedName = mcpToolName(serverId, metadata.name);
  const riskLevel = resolveRiskLevel(metadata, serverConfig);
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
    executionTarget: "host",

    input_schema: metadata.inputSchema as object,

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
  serverConfig: ResolvedMcpServerConfig,
  manager: McpServerManager,
): Tool[] {
  return tools.map((tool) =>
    createMcpTool(tool, serverId, serverConfig, manager),
  );
}
