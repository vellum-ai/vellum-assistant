import { z } from "zod";

/**
 * Risk level workspace MCP tools start at. Not a config field: origin
 * decides, and a tool's own MCP annotations then move it one step.
 */
export const WORKSPACE_MCP_RISK_LEVEL = "medium" as const;

/**
 * Risk level plugin-declared MCP tools start at. `mcp.json` has no risk
 * field. The marketplace whitelist plus the install decision is the
 * review, so these tools run without prompting under the default
 * auto-approve threshold.
 */
export const PLUGIN_MCP_RISK_LEVEL = "low" as const;

/** Per-server cap on tools registered from one MCP server. */
export const MCP_MAX_TOOLS_PER_SERVER = 20;

/** Cap on tools registered across every MCP server. */
export const MCP_GLOBAL_MAX_TOOLS = 50;

export type McpRiskLevel =
  | typeof WORKSPACE_MCP_RISK_LEVEL
  | typeof PLUGIN_MCP_RISK_LEVEL
  | "high";

const McpStdioTransportSchema = z
  .object({
    type: z.literal("stdio"),
    command: z
      .string({ error: "mcp transport command must be a string" })
      .describe("Command to spawn the MCP server process"),
    args: z
      .array(z.string())
      .default([])
      .describe("Arguments passed to the MCP server command"),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables set for the MCP server process"),
  })
  .describe(
    "Stdio transport: communicates with the MCP server via stdin/stdout",
  );

const McpSseTransportSchema = z
  .object({
    type: z.literal("sse"),
    url: z
      .string({ error: "mcp transport url must be a string" })
      .describe("URL of the MCP SSE endpoint"),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("Custom HTTP headers sent with SSE requests"),
  })
  .describe(
    "SSE transport: connects to an MCP server over Server-Sent Events",
  );

const McpStreamableHttpTransportSchema = z
  .object({
    type: z.literal("streamable-http"),
    url: z
      .string({ error: "mcp transport url must be a string" })
      .describe("URL of the MCP streamable HTTP endpoint"),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("Custom HTTP headers sent with requests"),
  })
  .describe(
    "Streamable HTTP transport: connects to an MCP server over HTTP with streaming",
  );

export const McpTransportSchema = z.discriminatedUnion("type", [
  McpStdioTransportSchema,
  McpSseTransportSchema,
  McpStreamableHttpTransportSchema,
]);

export const McpServerConfigSchema = z
  .object({
    transport: McpTransportSchema,
  })
  .describe("Configuration for an individual MCP server");

export const McpConfigSchema = z
  .object({
    servers: z
      .record(z.string(), McpServerConfigSchema)
      .default({} as Record<string, never>)
      .describe("Map of MCP server names to their configurations"),
  })
  .describe(
    "Model Context Protocol (MCP) configuration: connect external tool servers",
  );

export type McpTransport = z.infer<typeof McpTransportSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;

/**
 * Who declared a server: the workspace `config.json`, which the user owns,
 * or a plugin's `mcp.json`, which its author owns.
 *
 * Deliberately not a schema field. It is resolved from where the entry was
 * read, never parsed from a file, so nothing on disk can claim to be
 * workspace-owned. What it gates is credential access: only a workspace
 * server resolves `mcp:<serverId>:*` from the credential store, because a
 * plugin controls both its server key and its URL and would otherwise
 * receive a workspace credential at an endpoint it chose.
 */
export type McpServerSource = "workspace" | "plugin";

/** A server config with its origin resolved. */
export interface ResolvedMcpServerConfig extends McpServerConfig {
  readonly source: McpServerSource;
}

/** The MCP config the daemon runs: both origins, every server attributed. */
export interface ResolvedMcpConfig {
  readonly servers: Record<string, ResolvedMcpServerConfig>;
}

export function mcpSourceRiskLevel(source: McpServerSource): McpRiskLevel {
  return source === "plugin" ? PLUGIN_MCP_RISK_LEVEL : WORKSPACE_MCP_RISK_LEVEL;
}
