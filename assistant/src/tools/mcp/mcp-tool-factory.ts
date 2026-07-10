import type { McpServerConfig } from "../../config/schemas/mcp.js";
import { isAuthRelatedError } from "../../mcp/client.js";
import type { McpServerManager } from "../../mcp/manager.js";
import { refreshMcpTokens } from "../../mcp/mcp-token-refresh.js";
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
  const httpUrl =
    serverConfig.transport.type === "stdio"
      ? undefined
      : serverConfig.transport.url;

  const needsReauthMessage =
    `MCP server "${serverId}" needs re-authentication. Run ` +
    `\`assistant mcp auth ${serverId}\` and give the user the printed ` +
    `authorization URL as a clickable link.`;

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
      // Strip injected activity before sending to MCP server
      const { activity: _activity, ...mcpInput } = input as Record<
        string,
        unknown
      > & {
        activity?: unknown;
      };
      const forwardInput = serverDefinesActivity ? input : mcpInput;
      try {
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

        // On an auth failure, attempt a one-shot token refresh and retry the
        // call once. If tokens can't be refreshed (or the retry still fails
        // auth), return an actionable re-authentication instruction — the
        // model reads this text and relays it to the user.
        if (httpUrl && isAuthRelatedError(err)) {
          const refreshed = await refreshMcpTokens(serverId, httpUrl).catch(
            () => false,
          );
          if (refreshed) {
            try {
              const retry = await manager.callTool(
                serverId,
                metadata.name,
                forwardInput,
                context.signal,
              );
              return {
                content: retry.content,
                isError: retry.isError,
              };
            } catch (retryErr) {
              if (!isAuthRelatedError(retryErr)) {
                const retryMessage =
                  retryErr instanceof Error
                    ? retryErr.message
                    : String(retryErr);
                return {
                  content: `MCP tool execution failed: ${retryMessage}`,
                  isError: true,
                };
              }
            }
          }
          return {
            content: needsReauthMessage,
            isError: true,
          };
        }

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
