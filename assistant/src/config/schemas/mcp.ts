import { z } from "zod";

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
    "Stdio transport — communicates with the MCP server via stdin/stdout",
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
    "SSE transport — connects to an MCP server over Server-Sent Events",
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
    "Streamable HTTP transport — connects to an MCP server over HTTP with streaming",
  );

export const McpTransportSchema = z.discriminatedUnion("type", [
  McpStdioTransportSchema,
  McpSseTransportSchema,
  McpStreamableHttpTransportSchema,
]);

export const McpServerConfigSchema = z
  .object({
    transport: McpTransportSchema,
    enabled: z
      .boolean({ error: "mcp server enabled must be a boolean" })
      .default(true)
      .describe("Whether this MCP server is enabled"),
    defaultRiskLevel: z
      .enum(["low", "medium", "high"], {
        error: "mcp server defaultRiskLevel must be one of: low, medium, high",
      })
      .default("high")
      .describe(
        "Default risk level assigned to tools from this server (affects approval requirements)",
      ),
    maxTools: z
      .number({ error: "mcp server maxTools must be a number" })
      .int()
      .positive()
      .default(20)
      .describe("Maximum number of tools to register from this server"),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe(
        "Allowlist of tool names — only these tools will be registered (if set)",
      ),
    blockedTools: z
      .array(z.string())
      .optional()
      .describe("Blocklist of tool names — these tools will not be registered"),
  })
  .describe("Configuration for an individual MCP server");

export const McpConfigSchema = z
  .object({
    servers: z
      .record(z.string(), McpServerConfigSchema)
      .default({} as Record<string, never>)
      .describe("Map of MCP server names to their configurations"),
    globalMaxTools: z
      .number({ error: "mcp globalMaxTools must be a number" })
      .int()
      .positive()
      .default(50)
      .describe("Maximum total number of tools across all MCP servers"),
  })
  .describe(
    "Model Context Protocol (MCP) configuration — connect external tool servers",
  );

export type McpTransport = z.infer<typeof McpTransportSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
